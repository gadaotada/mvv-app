type SafeParseOk<T = unknown> = { ok: true; value: T };
type SafeParseFail = { ok: false; error: unknown };

export type SafeParseResult<T = unknown> = SafeParseOk<T> | SafeParseFail;
export function safeJsonParse<T = unknown>(value: string): SafeParseResult<T> {
  try {
    return { ok: true, value: JSON.parse(value) as T };
  } catch (error) {
    return { ok: false, error };
  }
}

type SafeStringifyOk<T extends string | undefined = string> = { ok: true; value: T };
type SafeStringifyFail = { ok: false; error: unknown };

export type SafeStringifyResult<T extends string | undefined = string> = SafeStringifyOk<T> | SafeStringifyFail;
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
