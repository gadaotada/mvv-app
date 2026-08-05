import type { PathLike } from 'node:fs';

export function assertIntegerInRange(name: string, value: unknown, minimum: number, maximum: number): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`Value of ${name} must be a safe integer from ${minimum} to ${maximum}`);
  }
}

export function isPathLike(path: unknown): path is PathLike {
  if (typeof path === 'string') return path.length > 0;
  if (Buffer.isBuffer(path)) return path.length > 0;
  return path instanceof URL && path.protocol === 'file:';
}

export function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (typeof value === 'object' && value !== null && 'then' in value) || (typeof value === 'function' && 'then' in value);
}
