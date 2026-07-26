import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';

import { HttpError, isHttpError } from './errors.js';
import { hasUnreadRequestBody, markConnectionForClosure } from './request.js';
import { json } from './response.js';
import type { Router } from './router.js';

export interface RequestErrorContext {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly signal: AbortSignal;
}

export interface HttpHandlerOptions {
  readonly onError?: (error: unknown, context: RequestErrorContext) => void | Promise<void>;
  readonly errorHandlerTimeoutMs?: number;
}

function defaultErrorHandler(error: unknown, context: RequestErrorContext): void {
  const { request, response } = context;
  const statusCode = isHttpError(error) ? error.statusCode : 500;
  const code = isHttpError(error) ? error.code : 'INTERNAL_SERVER_ERROR';
  const message = isHttpError(error) && error.expose ? error.message : 'Internal Server Error';

  if (statusCode >= 500 && !request.aborted && !response.destroyed) console.error(`Request failed: ${request.method ?? 'GET'} ${request.url ?? '/'}`, error);

  if (response.writableEnded || response.destroyed) return;

  if (response.headersSent) {
    response.destroy(error instanceof Error ? error : undefined);
    return;
  }

  if (isHttpError(error)) {
    for (const [name, value] of Object.entries(error.headers)) {
      if (value !== undefined) response.setHeader(name, value);
    }
  }

  if (hasUnreadRequestBody(request)) markConnectionForClosure(response);

  json(response, { error: { code, message } }, statusCode);
}

export function createHttpHandler(router: Router, options: HttpHandlerOptions = {}): RequestListener {
  const errorHandlerTimeoutMs = options.errorHandlerTimeoutMs ?? 5_000;

  if (!Number.isSafeInteger(errorHandlerTimeoutMs) || errorHandlerTimeoutMs <= 0) {
    throw new RangeError('Error handler timeout must be a positive safe integer');
  }

  async function handleError(error: unknown, request: IncomingMessage, response: ServerResponse): Promise<void> {
    const controller = new AbortController();
    const errorContext = { request, response, signal: controller.signal };
    const onClientDisconnected = () => controller.abort(new Error('Client connection closed'));

    request.once('aborted', onClientDisconnected);
    response.once('close', onClientDisconnected);

    if (request.aborted || response.destroyed || response.writableEnded) onClientDisconnected();

    try {
      if (!response.headersSent && !response.writableEnded && !response.destroyed && hasUnreadRequestBody(request)) markConnectionForClosure(response);

      if (options.onError === undefined) {
        defaultErrorHandler(error, errorContext);
      } else {
        let rejectAtDeadline!: (error: HttpError) => void;
        const deadline = new Promise<never>((_resolve, reject) => {
          rejectAtDeadline = reject;
        });
        const timeout = setTimeout(() => {
          const timeoutError = new HttpError(500, 'Request error handler timed out', {
            code: 'ERROR_HANDLER_TIMEOUT',
            expose: false,
          });
          rejectAtDeadline(timeoutError);
          controller.abort(timeoutError);
        }, errorHandlerTimeoutMs);
        timeout.unref();

        try {
          await Promise.race([Promise.resolve().then(() => options.onError?.(error, errorContext)), deadline]);
        } finally {
          clearTimeout(timeout);
        }

        if (!response.writableEnded && !response.destroyed) {
          throw new HttpError(500, 'Request error handler did not end the response', {
            code: 'ERROR_HANDLER_INCOMPLETE',
            expose: false,
          });
        }
      }
    } catch (handlerError) {
      console.error('Request error handler failed', handlerError);

      try {
        defaultErrorHandler(handlerError, errorContext);
      } catch (fallbackError) {
        console.error('Default request error handler failed', fallbackError);
        response.destroy(fallbackError instanceof Error ? fallbackError : undefined);
      }
    } finally {
      request.off('aborted', onClientDisconnected);
      response.off('close', onClientDisconnected);
    }
  }

  function startErrorHandling(error: unknown, request: IncomingMessage, response: ServerResponse): void {
    void handleError(error, request, response);
  }

  return (request, response) => {
    try {
      const pending = router.dispatch(request, response);
      if (pending !== undefined) void pending.catch((error: unknown) => startErrorHandling(error, request, response));
    } catch (error) {
      startErrorHandling(error, request, response);
    }
  };
}
