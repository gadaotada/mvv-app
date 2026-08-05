import type { Result } from '@mvv/core/types';

export type SafeParseResult<T = unknown> = Result<T, unknown>;
export function safeJsonParse<T = unknown>(value: string): SafeParseResult<T> {
  try {
    return { ok: true, value: JSON.parse(value) as T };
  } catch (error) {
    return { ok: false, error };
  }
}

export type SafeStringifyResult<T extends string | undefined = string> = Result<T, unknown>;
export function safeJsonStringify(value: unknown, nullish: true): SafeStringifyResult<string | undefined>;
export function safeJsonStringify(value: unknown, nullish?: false): SafeStringifyResult<string>;
export function safeJsonStringify(value: unknown, nullish = false): SafeStringifyResult<string | undefined> {
  try {
    const result = JSON.stringify(value);

    if (result === undefined) {
      if (nullish) return { ok: true, value: undefined };

      return {
        ok: false,
        error: new TypeError('Value cannot be serialized to JSON'),
      };
    }

    return { ok: true, value: result };
  } catch (error) {
    return { ok: false, error };
  }
}
