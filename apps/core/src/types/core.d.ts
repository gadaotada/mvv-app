/**
 * Temporary subset of the native Temporal API used by core.
 *
 * Node.js 26 provides Temporal at runtime, but TypeScript does not include its
 * declarations yet. Remove this once TypeScript ships the standard definitions.
 */
declare global {
  namespace Temporal {
    interface DurationLike {
      readonly milliseconds?: number;
      readonly minutes?: number;
    }

    interface Instant {
      readonly epochMilliseconds: number;

      add(duration: DurationLike): Instant;
    }

    namespace Now {
      function instant(): Instant;
    }
  }
}

/** Makes every property optional and allows its value to be null. */
export type PartialNullable<T> = {
  [Key in keyof T]?: T[Key] | null;
};

/** Boolean represented by the strings used by Y/N data sources. */
export type StringBool = 'Y' | 'N';

/** Boolean represented by numeric strings. */
export type NumBool = '1' | '0';

/** Flattens intersections and mapped types into a readable object shape. */
export type Prettify<T> = {
  [Key in keyof T]: T[Key];
} & {};

/** Represents either a successful value or an expected failure. */
export type Result<Ok, Err = Error> = { readonly ok: true; readonly value: Ok } | { readonly ok: false; readonly error: Err };

/** Adds null to a value type. */
export type Nullable<T> = T | null;

/** Adds null and undefined to a value type. */
export type Nullish<T> = T | null | undefined;

/** Represents either an immediate value or a promise-like value. */
export type MaybePromise<T> = T | PromiseLike<T>;

/** A readonly array containing at least one value. */
export type NonEmptyArray<T> = readonly [T, ...T[]];

/** Produces a union of an object's value types. */
export type ValueOf<T> = T[keyof T];

/** Omit variant that rejects keys not present on the source type. */
export type StrictOmit<T, Key extends keyof T> = Omit<T, Key>;

/** JSON-compatible primitive values. */
export type JsonPrimitive = string | number | boolean | null;

/** JSON-compatible object values. */
export type JsonObject = {
  readonly [key: string]: JsonValue;
};

/** Any JSON-compatible value. */
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];

declare const mvvTypeBrand: unique symbol;

/** Creates a nominal distinction between otherwise compatible value types. */
export type Brand<Value, Name extends string> = Value & {
  readonly [mvvTypeBrand]: Name;
};

/** Makes the selected properties optional. */
export type SetOptional<T, Key extends keyof T> = Prettify<Omit<T, Key> & Partial<Pick<T, Key>>>;

/** Makes the selected properties required. */
export type SetRequired<T, Key extends keyof T> = Prettify<Omit<T, Key> & Required<Pick<T, Key>>>;
