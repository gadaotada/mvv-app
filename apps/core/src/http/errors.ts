import type { OutgoingHttpHeaders } from 'node:http';

export interface HttpErrorOptions {
  readonly code?: string;
  readonly expose?: boolean;
  readonly headers?: Readonly<OutgoingHttpHeaders>;
  readonly cause?: unknown;
}

export class HttpError extends Error {
  override readonly name = 'HttpError';
  readonly code: string;
  readonly expose: boolean;
  readonly headers: Readonly<OutgoingHttpHeaders>;

  constructor(
    readonly statusCode: number,
    message: string,
    options: HttpErrorOptions = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });

    if (!Number.isInteger(statusCode) || statusCode < 400 || statusCode > 599) throw new RangeError('HTTP error status must be an integer between 400 and 599');

    this.code = options.code ?? `HTTP_${statusCode}`;
    this.expose = options.expose ?? statusCode < 500;
    this.headers = options.headers ?? {};
  }
}

export function isHttpError(error: unknown): error is HttpError {
  return error instanceof HttpError;
}
