import type { IncomingMessage } from 'node:http';

import { safeJsonParse } from '../utils/json.js';
import { HttpError } from './errors.js';

export interface BodyReaderOptions {
  readonly limit?: number;
  readonly signal?: AbortSignal;
}

export interface BodyReaderConfig {
  readonly limit: number;
}

export interface BodyReader {
  read(request: IncomingMessage, options?: BodyReaderOptions): Promise<Buffer>;
  json(request: IncomingMessage, options?: BodyReaderOptions): Promise<unknown>;
}

const claimedRequests = new WeakSet<IncomingMessage>();

function validateLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError('Body limit must be a non-negative safe integer');

  return limit;
}

function validateDeclaredLength(request: IncomingMessage, limit: number): void {
  const declaredLength = request.headers['content-length'];

  if (declaredLength !== undefined) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0) throw new HttpError(400, 'Invalid Content-Length header', { code: 'INVALID_CONTENT_LENGTH' });

    if (length > limit) {
      request.pause();
      throw new HttpError(413, 'Request body is too large', {
        code: 'BODY_TOO_LARGE',
        headers: { connection: 'close' },
      });
    }
  }
}

function readBody(request: IncomingMessage, limit: number, signal?: AbortSignal): Promise<Buffer> {
  validateDeclaredLength(request, limit);

  if (claimedRequests.has(request)) {
    throw new HttpError(500, 'Request body has already been consumed', {
      code: 'BODY_ALREADY_CONSUMED',
      expose: false,
    });
  }

  if (request.readableEnded || request.destroyed) {
    throw new HttpError(500, 'Request body is no longer readable', {
      code: 'BODY_UNAVAILABLE',
      expose: false,
    });
  }

  claimedRequests.add(request);

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;

    const cleanup = () => {
      request.off('data', onData);
      request.off('end', onEnd);
      request.off('error', onError);
      request.off('aborted', onAborted);
      signal?.removeEventListener('abort', onAbort);
    };

    const settle = (callback: () => void) => {
      if (settled) return;

      settled = true;
      cleanup();
      callback();
    };

    const onData = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.byteLength;

      if (size > limit) {
        settle(() =>
          reject(
            new HttpError(413, 'Request body is too large', {
              code: 'BODY_TOO_LARGE',
              headers: { connection: 'close' },
            }),
          ),
        );
        request.pause();

        return;
      }

      chunks.push(buffer);
    };

    const onEnd = () => settle(() => resolve(Buffer.concat(chunks, size)));
    const onError = (error: Error) => settle(() => reject(error));
    const onAborted = () => settle(() => reject(new HttpError(400, 'Request was aborted', { code: 'REQUEST_ABORTED' })));

    const onAbort = () => {
      settle(() => reject(new HttpError(408, 'Request body timed out', { code: 'BODY_TIMEOUT' })));
      request.destroy();
    };

    if (signal?.aborted === true) {
      onAbort();
      return;
    }

    request.on('data', onData);
    request.once('end', onEnd);
    request.once('error', onError);
    request.once('aborted', onAborted);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function readJson(request: IncomingMessage, limit: number, signal?: AbortSignal): Promise<unknown> {
  validateDeclaredLength(request, limit);
  const contentType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();

  if (contentType !== 'application/json') {
    request.pause();
    throw new HttpError(415, 'Content-Type must be application/json', {
      code: 'UNSUPPORTED_CONTENT_TYPE',
      headers: { connection: 'close' },
    });
  }

  const body = await readBody(request, limit, signal);
  if (body.byteLength === 0) throw new HttpError(400, 'JSON body must not be empty', { code: 'EMPTY_JSON_BODY' });

  const parsed = safeJsonParse(body.toString('utf8'));
  if (parsed.ok) return parsed.value;

  throw new HttpError(400, 'Request body contains invalid JSON', { code: 'INVALID_JSON', cause: parsed.error });
}

export function createBodyReader(config: BodyReaderConfig): BodyReader {
  const configuredLimit = validateLimit(config.limit);
  const resolveLimit = (options: BodyReaderOptions): number => (options.limit === undefined ? configuredLimit : validateLimit(options.limit));

  return Object.freeze({
    read(request: IncomingMessage, options: BodyReaderOptions = {}) {
      return readBody(request, resolveLimit(options), options.signal);
    },
    json(request: IncomingMessage, options: BodyReaderOptions = {}) {
      return readJson(request, resolveLimit(options), options.signal);
    },
  });
}
