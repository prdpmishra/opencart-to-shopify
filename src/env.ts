export function requireEnv(name: string, allowEmpty = false): string {
    const value = process.env[name];
    if (value === undefined || (!allowEmpty && value === ""))
        throw new Error(`Missing environment variable: ${name}`);

    return value;
}
