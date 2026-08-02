export function assertIntegerInRange(name: string, value: unknown, minimum: number, maximum: number): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`Value of ${name} must be a safe integer from ${minimum} to ${maximum}`);
  }
}
