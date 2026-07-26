export interface StringEnvOptions {
  readonly fallback?: string;
  readonly allowEmpty?: boolean;
  readonly trim?: boolean;
}

export interface IntegerEnvOptions {
  readonly fallback?: number;
  readonly min?: number;
  readonly max?: number;
}

export interface BooleanEnvOptions {
  readonly fallback?: boolean;
}

export class EnvironmentError extends Error {
  override readonly name = 'EnvironmentError';

  constructor(
    readonly key: string,
    message: string,
  ) {
    super(`Environment variable ${key}: ${message}`);
  }
}

export class Environment {
  constructor(private readonly values: Readonly<Record<string, string | undefined>> = process.env) {}

  required(key: string, options: Omit<StringEnvOptions, 'fallback'> = {}): string {
    const value = this.string(key, options);

    if (value === undefined) throw new EnvironmentError(key, 'is required');

    return value;
  }

  string(key: string): string | undefined;
  string(key: string, options: StringEnvOptions & { readonly fallback: string }): string;
  string(key: string, options?: StringEnvOptions): string | undefined;
  string(key: string, options: StringEnvOptions = {}): string | undefined {
    const raw = this.values[key];
    const value = raw === undefined ? options.fallback : options.trim === false ? raw : raw.trim();

    if (value === undefined) return undefined;

    if (value.length === 0 && options.allowEmpty !== true) throw new EnvironmentError(key, 'must not be empty');

    return value;
  }

  integer(key: string): number | undefined;
  integer(key: string, options: IntegerEnvOptions & { readonly fallback: number }): number;
  integer(key: string, options?: IntegerEnvOptions): number | undefined;
  integer(key: string, options: IntegerEnvOptions = {}): number | undefined {
    const raw = this.values[key]?.trim();
    if (raw?.length === 0) throw new EnvironmentError(key, 'must not be empty');

    const value = raw === undefined ? options.fallback : Number(raw);

    if (value === undefined) return undefined;

    if (!Number.isSafeInteger(value)) throw new EnvironmentError(key, 'must be a safe integer');

    if (options.min !== undefined && value < options.min) throw new EnvironmentError(key, `must be at least ${options.min}`);

    if (options.max !== undefined && value > options.max) throw new EnvironmentError(key, `must be at most ${options.max}`);

    return value;
  }

  boolean(key: string): boolean | undefined;
  boolean(key: string, options: BooleanEnvOptions & { readonly fallback: boolean }): boolean;
  boolean(key: string, options?: BooleanEnvOptions): boolean | undefined;
  boolean(key: string, options: BooleanEnvOptions = {}): boolean | undefined {
    const raw = this.values[key]?.trim().toLowerCase();

    if (raw === undefined) return options.fallback;

    if (raw === 'true' || raw === '1') return true;

    if (raw === 'false' || raw === '0') return false;

    throw new EnvironmentError(key, 'must be true, false, 1, or 0');
  }

  oneOf<const Value extends string>(key: string, allowed: readonly Value[], fallback?: Value): Value | undefined {
    const value = this.string(key, fallback === undefined ? {} : { fallback });

    if (value === undefined) return undefined;

    if (!allowed.includes(value as Value)) throw new EnvironmentError(key, `must be one of: ${allowed.join(', ')}`);

    return value as Value;
  }
}

export function createEnvironment(values: Readonly<Record<string, string | undefined>> = process.env): Environment {
  return new Environment(values);
}
