-- Anonymises a COPY of an OpenCart 3 database, so a test migration sends no
-- real names, emails, phone numbers, street addresses or comments to Shopify.
-- Kept as they are: countries, zones, cities and postcodes (address handling
-- is tested on real data), and everything that isn't personal: products,
-- prices, order totals, statuses and dates.
--
-- Fakes are consistent: the same email or phone number always becomes the
-- same fake one (within one run), so orders still match their customers and
-- shared phone numbers stay shared. A phone keeps its format and first three
-- digits, so it still parses as a number of the same country.
--
-- Usage (only ever on a copy):
--   mysql -u root -e "CREATE DATABASE opencart_anon CHARACTER SET utf8mb4"
--   mysqldump -u root opencart | mysql -u root opencart_anon
--   mysql -u root opencart_anon < scripts/anonymise.sql
--
-- Written for tables without a prefix: add the prefix to the table names if
-- the copy has one.

-- Refuses to run on a database whose name doesn't end in "_anon".
DROP PROCEDURE IF EXISTS anon_check_database;
DELIMITER //
CREATE PROCEDURE anon_check_database()
BEGIN
    IF DATABASE() IS NULL OR DATABASE() NOT LIKE '%\_anon' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Not a copy: the database name must end in _anon. Nothing was changed.';
    END IF;
END //
DELIMITER ;
CALL anon_check_database();
DROP PROCEDURE anon_check_database;

-- A new random salt each run (not stored), so the fakes can't be traced back.
SET @salt = SHA2(CONCAT(RAND(), NOW(6), CONNECTION_ID()), 256);

DROP FUNCTION IF EXISTS anon_email;
DROP FUNCTION IF EXISTS anon_phone;
DELIMITER //
-- "jan@site.nl" → "test-1a2b3c4d5e6f7a8b@example.com" (example.com never receives mail).
-- An address without "@" stays invalid, so that case is still tested.
CREATE FUNCTION anon_email(email VARCHAR(255)) RETURNS VARCHAR(255) DETERMINISTIC
BEGIN
    DECLARE hash CHAR(64) DEFAULT SHA2(CONCAT(@salt, LOWER(TRIM(email))), 256);
    IF TRIM(email) = '' THEN RETURN email; END IF;
    IF email NOT LIKE '%@%' THEN RETURN CONCAT('invalid-', LEFT(hash, 8)); END IF;
    RETURN CONCAT('test-', LEFT(hash, 16), '@example.com');
END //

-- "06-12345678" → "06-1" + other digits: the format and first three digits are
-- kept, the rest comes from a hash of the number's digits.
CREATE FUNCTION anon_phone(phone VARCHAR(64)) RETURNS VARCHAR(64) DETERMINISTIC
BEGIN
    DECLARE hash CHAR(64) DEFAULT SHA2(CONCAT(@salt, REGEXP_REPLACE(phone, '[^0-9]', '')), 256);
    DECLARE result VARCHAR(64) DEFAULT '';
    DECLARE i INT DEFAULT 1;
    DECLARE digits INT DEFAULT 0;
    DECLARE c VARCHAR(1);
    IF TRIM(phone) = '' THEN RETURN phone; END IF;
    -- Junk without digits (sometimes even an email address): stays invalid, nothing of it is kept.
    IF phone NOT REGEXP '[0-9]' THEN RETURN 'invalid-phone'; END IF;
    WHILE i <= CHAR_LENGTH(phone) DO
        SET c = SUBSTRING(phone, i, 1);
        IF c REGEXP '[0-9]' THEN
            SET digits = digits + 1;
            IF digits > 3 THEN SET c = CONV(SUBSTRING(hash, digits, 1), 16, 10) % 10; END IF;
        END IF;
        SET result = CONCAT(result, c);
        SET i = i + 1;
    END WHILE;
    RETURN result;
END //
DELIMITER ;

-- Orders first: their email and phone fakes must match the customers', which
-- works because both come from the same functions.
UPDATE `order` SET
    firstname = 'Test',
    lastname = IF(customer_id > 0, CONCAT('Customer ', customer_id), CONCAT('Guest ', order_id)),
    email = anon_email(email),
    telephone = anon_phone(telephone),
    fax = '',
    custom_field = '',
    payment_firstname = IF(payment_firstname = '', '', 'Test'),
    payment_lastname = IF(payment_lastname = '', '',
        IF(customer_id > 0, CONCAT('Customer ', customer_id), CONCAT('Guest ', order_id))),
    payment_company = IF(payment_company = '', '', CONCAT('Company ', order_id)),
    payment_address_1 = IF(payment_address_1 = '', '', CONCAT('Teststraat ', order_id % 200 + 1)),
    payment_address_2 = IF(payment_address_2 = '', '', 'Unit 2'),
    payment_custom_field = '',
    payment_tax_id = '',
    shipping_firstname = IF(shipping_firstname = '', '', 'Test'),
    shipping_lastname = IF(shipping_lastname = '', '',
        IF(customer_id > 0, CONCAT('Customer ', customer_id), CONCAT('Guest ', order_id))),
    shipping_company = IF(shipping_company = '', '', CONCAT('Company ', order_id)),
    shipping_address_1 = IF(shipping_address_1 = '', '', CONCAT('Teststraat ', order_id % 200 + 1)),
    shipping_address_2 = IF(shipping_address_2 = '', '', 'Unit 2'),
    shipping_custom_field = '',
    comment = IF(TRIM(comment) = '', '', '[comment removed]'),
    tracking = '',
    ip = '',
    forwarded_ip = '',
    user_agent = '',
    accept_language = '';

UPDATE order_history SET comment = IF(TRIM(comment) = '', '', '[comment removed]');

-- Text the customer typed in a product option (e.g. a name to engrave) or an
-- uploaded file; chosen values (select, radio, checkbox) are kept.
UPDATE order_option SET value = '[removed]' WHERE type IN ('text', 'textarea', 'file') AND value <> '';

UPDATE customer SET
    firstname = 'Test',
    lastname = CONCAT('Customer ', customer_id),
    email = anon_email(email),
    telephone = anon_phone(telephone),
    fax = '',
    custom_field = '',
    password = '',
    salt = '',
    token = '',
    code = '',
    ip = '',
    cart = NULL,
    wishlist = NULL;

UPDATE address SET
    firstname = 'Test',
    lastname = CONCAT('Customer ', customer_id),
    company = IF(company = '', '', CONCAT('Company ', address_id)),
    address_1 = IF(address_1 = '', '', CONCAT('Teststraat ', address_id % 200 + 1)),
    address_2 = IF(address_2 = '', '', 'Unit 2'),
    custom_field = '',
    tax_id = '';

-- Gift vouchers: who sent one to whom, and their message.
UPDATE voucher SET
    from_name = IF(from_name = '', '', 'Test'),
    from_email = anon_email(from_email),
    to_name = IF(to_name = '', '', 'Test'),
    to_email = anon_email(to_email),
    message = IF(TRIM(message) = '', '', '[message removed]');
UPDATE order_voucher SET
    from_name = IF(from_name = '', '', 'Test'),
    from_email = anon_email(from_email),
    to_name = IF(to_name = '', '', 'Test'),
    to_email = anon_email(to_email),
    message = IF(TRIM(message) = '', '', '[message removed]');

-- Personal data the migration doesn't read: emptied, so the copy holds none.
-- Some of these tables only exist with an extension, so missing ones are skipped.
DROP PROCEDURE IF EXISTS anon_empty;
DELIMITER //
CREATE PROCEDURE anon_empty(name VARCHAR(64))
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = name) THEN
        SET @sql = CONCAT('TRUNCATE `', name, '`');
        PREPARE statement FROM @sql;
        EXECUTE statement;
        DEALLOCATE PREPARE statement;
    END IF;
END //
DELIMITER ;
CALL anon_empty('address_simple_fields');
CALL anon_empty('customer_simple_fields');
CALL anon_empty('order_simple_fields');
CALL anon_empty('order_custom_field');
CALL anon_empty('order_fraud');
CALL anon_empty('order_shipment');
CALL anon_empty('customer_activity');
CALL anon_empty('customer_affiliate');
CALL anon_empty('customer_approval');
CALL anon_empty('customer_ban_ip');
CALL anon_empty('customer_history');
CALL anon_empty('customer_ip');
CALL anon_empty('customer_login');
CALL anon_empty('customer_online');
CALL anon_empty('customer_search');
CALL anon_empty('customer_transaction');
CALL anon_empty('return');
CALL anon_empty('return_history');
CALL anon_empty('review');

DROP PROCEDURE anon_empty;
DROP FUNCTION anon_email;
DROP FUNCTION anon_phone;
