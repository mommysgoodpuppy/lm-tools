export function takeValue(args: string[], index: number, option: string): string {
  const value = args[index + 1];
  if (value === undefined) throw new Error(`${option} requires a value`);
  return value;
}

export function parsePositiveInteger(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${option} must be a positive integer`);
  }
  return parsed;
}

export function parseNonNegativeInteger(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${option} must be a non-negative integer`);
  }
  return parsed;
}

export function parsePort(value: string, option: string): number {
  const port = parsePositiveInteger(value, option);
  if (port > 65535) throw new Error(`${option} must be between 1 and 65535`);
  return port;
}
