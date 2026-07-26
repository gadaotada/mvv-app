import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingHttpHeaders, IncomingMessage, OutgoingHttpHeader, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';

import { createBodyReader } from './body.js';
import { HttpError } from './errors.js';
import { createHttpHandler } from './handler.js';
import { json, send } from './response.js';
import { Router } from './router.js';

class TestRequest extends Readable {
  readonly headers: IncomingHttpHeaders;
  method: string;
  url: string;
  private sent = false;

  constructor(options: { readonly method?: string; readonly url: string; readonly headers?: IncomingHttpHeaders; readonly body?: string }) {
    super();
    this.method = options.method ?? 'GET';
    this.url = options.url;
    this.headers = options.headers ?? {};

    if (options.body !== undefined) {
      this.headers['content-length'] ??= String(Buffer.byteLength(options.body));
      this.body = Buffer.from(options.body);
    }
  }

  private readonly body?: Buffer;

  override _read(): void {
    if (this.sent) return;

    this.sent = true;

    if (this.body !== undefined) this.push(this.body);

    this.push(null);
  }
}

class TestResponse extends EventEmitter {
  statusCode = 200;
  headersSent = false;
  writableEnded = false;
  destroyed = false;
  readonly headers = new Map<string, OutgoingHttpHeader>();
  readonly completed: Promise<void>;
  body = Buffer.alloc(0);
  private complete!: () => void;

  constructor() {
    super();
    this.completed = new Promise((resolve) => {
      this.complete = resolve;
    });
  }

  setHeader(name: string, value: OutgoingHttpHeader): this {
    this.headers.set(name.toLowerCase(), value);
    return this;
  }

  hasHeader(name: string): boolean {
    return this.headers.has(name.toLowerCase());
  }

  getHeader(name: string): OutgoingHttpHeader | undefined {
    return this.headers.get(name.toLowerCase());
  }

  removeHeader(name: string): void {
    this.headers.delete(name.toLowerCase());
  }

  end(chunk?: string | Uint8Array): this {
    if (chunk !== undefined) this.body = Buffer.from(chunk);

    this.headersSent = true;
    this.writableEnded = true;
    this.emit('finish');
    this.complete();
    return this;
  }

  destroy(): this {
    this.destroyed = true;
    this.complete();
    return this;
  }
}

function asRequest(request: TestRequest): IncomingMessage {
  return request as unknown as IncomingMessage;
}

function asResponse(response: TestResponse): ServerResponse {
  return response as unknown as ServerResponse;
}

describe('HTTP core', () => {
  const router = new Router();
  const handler = createHttpHandler(router);
  const body = createBodyReader({ limit: 16 });

  router.get('/hello/:name', ({ params, response }) => {
    json(response, { hello: params.name });
  });

  router.post('/echo', async ({ request, response }) => {
    const value = await body.json(request);
    json(response, value, 201);
  });

  router.get('/private', () => {
    throw new HttpError(403, 'Nope', { code: 'NOPE' });
  });

  async function request(options: ConstructorParameters<typeof TestRequest>[0]): Promise<TestResponse> {
    const incoming = new TestRequest(options);
    const response = new TestResponse();
    handler(asRequest(incoming), asResponse(response));
    await response.completed;
    return response;
  }

  it('matches decoded parameters', async () => {
    const response = await request({
      url: '/hello/Miro%20V',
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(JSON.parse(response.body.toString()), { hello: 'Miro V' });
  });

  it('completes synchronous routes without deferring them to a microtask', () => {
    const syncRouter = new Router();
    syncRouter.get('/sync', ({ response }) => {
      json(response, { synchronous: true });
    });
    const syncHandler = createHttpHandler(syncRouter);
    const response = new TestResponse();

    syncHandler(asRequest(new TestRequest({ url: '/sync' })), asResponse(response));

    assert.equal(response.writableEnded, true);
    assert.deepEqual(JSON.parse(response.body.toString()), { synchronous: true });
  });

  it('waits for asynchronous routes before checking their response', async () => {
    const asyncRouter = new Router();
    asyncRouter.get('/async', async ({ response }) => {
      await Promise.resolve();
      json(response, { asynchronous: true });
    });
    const asyncHandler = createHttpHandler(asyncRouter);
    const response = new TestResponse();

    asyncHandler(asRequest(new TestRequest({ url: '/async' })), asResponse(response));
    assert.equal(response.writableEnded, false);

    await response.completed;
    assert.deepEqual(JSON.parse(response.body.toString()), { asynchronous: true });
  });

  it('prioritizes indexed static routes and matches their decoded path', async () => {
    const indexedRouter = new Router();
    indexedRouter.get('/:value', ({ response }) => {
      json(response, { route: 'dynamic' });
    });
    indexedRouter.get('/café', ({ response }) => {
      json(response, { route: 'static' });
    });
    const indexedHandler = createHttpHandler(indexedRouter);
    const response = new TestResponse();

    indexedHandler(asRequest(new TestRequest({ url: '/caf%C3%A9?source=test' })), asResponse(response));
    await response.completed;

    assert.deepEqual(JSON.parse(response.body.toString()), { route: 'static' });
  });

  it('sends strings and typed-array views with exact content lengths', () => {
    const textResponse = new TestResponse();
    send(asResponse(textResponse), 'Здравей');
    assert.equal(textResponse.getHeader('content-length'), Buffer.byteLength('Здравей'));
    assert.equal(textResponse.body.toString(), 'Здравей');

    const bytes = Uint8Array.from([0, 1, 2, 3]);
    const binaryResponse = new TestResponse();
    send(asResponse(binaryResponse), bytes.subarray(1, 3));
    assert.equal(binaryResponse.getHeader('content-length'), 2);
    assert.deepEqual(binaryResponse.body, Buffer.from([1, 2]));
  });

  it('reports missing routes and exposed HTTP errors', async () => {
    const missing = await request({ url: '/missing' });
    const forbidden = await request({ url: '/private' });

    assert.equal(missing.statusCode, 404);
    assert.equal(JSON.parse(missing.body.toString()).error.code, 'ROUTE_NOT_FOUND');
    assert.equal(forbidden.statusCode, 403);
    assert.equal(JSON.parse(forbidden.body.toString()).error.message, 'Nope');
  });

  it('handles OPTIONS and method-not-allowed responses', async () => {
    const options = await request({ method: 'OPTIONS', url: '/hello/test' });
    const rejected = await request({ method: 'POST', url: '/hello/test' });

    assert.equal(options.statusCode, 204);
    assert.match(String(options.getHeader('allow')), /GET/);
    assert.equal(rejected.statusCode, 405);
    assert.match(String(rejected.getHeader('allow')), /HEAD/);
  });

  it('parses JSON and enforces body limits', async () => {
    const accepted = await request({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
      body: '{"ok":true}',
    });
    const rejected = await request({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'this is too large' }),
    });

    assert.equal(accepted.statusCode, 201);
    assert.deepEqual(JSON.parse(accepted.body.toString()), { ok: true });
    assert.equal(rejected.statusCode, 413);
  });

  it('validates configured and overridden body limits', () => {
    assert.throws(() => createBodyReader({ limit: -1 }), RangeError);
    assert.throws(() => createBodyReader({ limit: Number.MAX_SAFE_INTEGER + 1 }), RangeError);
    assert.throws(() => body.read(asRequest(new TestRequest({ url: '/' })), { limit: -1 }), RangeError);
  });

  it('rejects repeated and unavailable body reads instead of hanging', async () => {
    const incoming = new TestRequest({ url: '/', body: 'once' });

    assert.equal((await body.read(asRequest(incoming))).toString(), 'once');
    assert.throws(
      () => body.read(asRequest(incoming)),
      (error: unknown) => error instanceof HttpError && error.code === 'BODY_ALREADY_CONSUMED',
    );

    const unavailable = new TestRequest({ url: '/' });
    unavailable.destroy();
    assert.throws(
      () => body.read(asRequest(unavailable)),
      (error: unknown) => error instanceof HttpError && error.code === 'BODY_UNAVAILABLE',
    );
  });

  it('terminates body reads when their signal is aborted', async () => {
    const incoming = new TestRequest({ url: '/' });
    const controller = new AbortController();
    controller.abort(new Error('deadline'));

    await assert.rejects(body.read(asRequest(incoming), { signal: controller.signal }), (error: unknown) => {
      return error instanceof HttpError && error.code === 'BODY_TIMEOUT';
    });
    assert.equal(incoming.destroyed, true);
  });

  it('rejects noncanonical paths before URL normalization', async () => {
    for (const url of ['/public/../private', '/public/%2e%2e/private', '/hello//test', '/hello%2ftest', '/hello\\test']) {
      const response = await request({ url });
      assert.equal(response.statusCode, 400, url);
      assert.equal(JSON.parse(response.body.toString()).error.code, 'NONCANONICAL_PATH', url);
    }
  });

  it('rejects raw URL fragments before normalization', async () => {
    for (const url of ['/hello/test#admin', '/hello/test?view=public#admin']) {
      const response = await request({ url });
      assert.equal(response.statusCode, 400, url);
      assert.equal(JSON.parse(response.body.toString()).error.code, 'INVALID_REQUEST_URL', url);
    }
  });

  it('stores __proto__ parameters as ordinary own properties', async () => {
    const protoRouter = new Router();
    protoRouter.get('/:__proto__', ({ params, response }) => {
      json(response, {
        own: Object.hasOwn(params, '__proto__'),
        value: params.__proto__,
      });
    });
    const protoHandler = createHttpHandler(protoRouter);
    const incoming = new TestRequest({ url: '/safe' });
    const response = new TestResponse();

    protoHandler(asRequest(incoming), asResponse(response));
    await response.completed;

    assert.deepEqual(JSON.parse(response.body.toString()), { own: true, value: 'safe' });
  });

  it('times out handlers, aborts their signal, and detects incomplete responses', async () => {
    const timeoutRouter = new Router({ handlerTimeoutMs: 20 });
    let aborted = false;
    timeoutRouter.get('/hang', async ({ signal }) => {
      await new Promise<void>((resolve) => {
        signal.addEventListener(
          'abort',
          () => {
            aborted = true;
            resolve();
          },
          { once: true },
        );
      });
    });
    timeoutRouter.get('/incomplete', () => undefined);
    const timeoutHandler = createHttpHandler(timeoutRouter);

    const hangingResponse = new TestResponse();
    timeoutHandler(asRequest(new TestRequest({ url: '/hang' })), asResponse(hangingResponse));
    await hangingResponse.completed;
    assert.equal(hangingResponse.statusCode, 504);
    assert.equal(JSON.parse(hangingResponse.body.toString()).error.code, 'HANDLER_TIMEOUT');
    assert.equal(aborted, true);

    const incompleteResponse = new TestResponse();
    timeoutHandler(asRequest(new TestRequest({ url: '/incomplete' })), asResponse(incompleteResponse));
    await incompleteResponse.completed;
    assert.equal(incompleteResponse.statusCode, 500);
    assert.equal(JSON.parse(incompleteResponse.body.toString()).error.code, 'INCOMPLETE_RESPONSE');
  });

  it('bounds custom error handlers and falls back when they do not respond', async () => {
    const errorRouter = new Router();
    errorRouter.get('/fail', () => {
      throw new Error('route failed');
    });

    const incompleteHandler = createHttpHandler(errorRouter, {
      onError: () => undefined,
    });
    const incompleteResponse = new TestResponse();
    incompleteHandler(asRequest(new TestRequest({ url: '/fail' })), asResponse(incompleteResponse));
    await incompleteResponse.completed;
    assert.equal(incompleteResponse.statusCode, 500);
    assert.equal(JSON.parse(incompleteResponse.body.toString()).error.code, 'ERROR_HANDLER_INCOMPLETE');

    let aborted = false;
    const hangingHandler = createHttpHandler(errorRouter, {
      errorHandlerTimeoutMs: 20,
      onError: async (_error, { signal }) => {
        await new Promise<void>((resolve) => {
          signal.addEventListener(
            'abort',
            () => {
              aborted = true;
              resolve();
            },
            { once: true },
          );
        });
      },
    });
    const hangingResponse = new TestResponse();
    hangingHandler(asRequest(new TestRequest({ url: '/fail' })), asResponse(hangingResponse));
    await hangingResponse.completed;
    assert.equal(hangingResponse.statusCode, 500);
    assert.equal(JSON.parse(hangingResponse.body.toString()).error.code, 'ERROR_HANDLER_TIMEOUT');
    assert.equal(aborted, true);
  });

  it('marks unread request bodies for connection closure before custom error handling', async () => {
    const errorRouter = new Router();
    errorRouter.post('/reject', () => {
      throw new HttpError(403, 'Rejected');
    });
    let connection: OutgoingHttpHeader | undefined;
    const errorHandler = createHttpHandler(errorRouter, {
      onError: (_error, { response }) => {
        connection = response.getHeader('connection');
        json(response, { rejected: true }, 403);
      },
    });
    const incoming = new TestRequest({
      method: 'POST',
      url: '/reject',
      body: '{}',
    });
    const response = new TestResponse();

    errorHandler(asRequest(incoming), asResponse(response));
    await response.completed;

    assert.equal(connection, 'close');
    assert.equal(response.getHeader('connection'), 'close');
  });

  it('logs unexpected server errors after the response has ended', { timeout: 500 }, async () => {
    const errorRouter = new Router();
    const expected = new Error('failed after response');
    errorRouter.get('/late-failure', ({ response }) => {
      json(response, { accepted: true });
      throw expected;
    });
    const errorHandler = createHttpHandler(errorRouter);
    const incoming = new TestRequest({ url: '/late-failure' });
    const response = new TestResponse();
    const originalConsoleError = console.error;
    const { promise: logged, resolve: resolveLogged } = Promise.withResolvers<readonly unknown[]>();
    console.error = (...values: readonly unknown[]) => resolveLogged(values);

    try {
      errorHandler(asRequest(incoming), asResponse(response));
      await response.completed;

      const values = await logged;
      assert.match(String(values[0]), /GET \/late-failure/);
      assert.equal(values[1], expected);
    } finally {
      console.error = originalConsoleError;
    }
  });

  it('aborts custom error handling when the client disconnects', async () => {
    const errorRouter = new Router();
    errorRouter.get('/fail', () => {
      throw new Error('route failed');
    });

    const { promise: errorHandlingStarted, resolve: startErrorHandling } = Promise.withResolvers<void>();
    const { promise: cancellationObserved, resolve: observeCancellation } = Promise.withResolvers<void>();
    let errorSignal: AbortSignal | undefined;
    const handler = createHttpHandler(errorRouter, {
      onError: async (_error, { signal }) => {
        errorSignal = signal;
        startErrorHandling();

        if (signal.aborted) {
          observeCancellation();
          return;
        }

        await new Promise<void>((resolve) => {
          signal.addEventListener(
            'abort',
            () => {
              observeCancellation();
              resolve();
            },
            { once: true },
          );
        });
      },
    });
    const incoming = new TestRequest({ url: '/fail' });
    const response = new TestResponse();

    handler(asRequest(incoming), asResponse(response));
    await errorHandlingStarted;
    response.destroy();
    incoming.emit('aborted');
    await cancellationObserved;

    assert.equal(errorSignal?.aborted, true);
  });

  it('validates the custom error handler timeout', () => {
    assert.throws(() => createHttpHandler(router, { errorHandlerTimeoutMs: 0 }), RangeError);
  });
});
