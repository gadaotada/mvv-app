import assert from 'node:assert/strict';
import { type AddressInfo } from 'node:net';
import { createConnection } from 'node:net';
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { after, before, describe, it } from 'node:test';

import { createBodyReader } from './body.js';
import { HttpError } from './errors.js';
import { createHttpHandler } from './handler.js';
import { json, send } from './response.js';
import { Router } from './router.js';

interface TestResponse {
  readonly statusCode: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
}

const host = '127.0.0.1';
const bodyLimit = 64;
let server: Server | undefined;
let port: number;

function request(
  method: string,
  path: string,
  options: {
    readonly headers?: Readonly<Record<string, string | string[]>>;
    readonly chunks?: readonly (string | Buffer)[];
  } = {},
): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      {
        host,
        port,
        method,
        path,
        headers: options.headers,
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
        incoming.once('end', () =>
          resolve({
            statusCode: incoming.statusCode ?? 0,
            headers: incoming.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );

    outgoing.once('error', reject);
    for (const chunk of options.chunks ?? []) {
      outgoing.write(chunk);
    }
    outgoing.end();
  });
}

function rawRequest(payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port });
    const chunks: Buffer[] = [];

    socket.setTimeout(2_000, () => socket.destroy(new Error('Raw HTTP request timed out')));
    socket.once('connect', () => socket.end(payload));
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.once('end', () => resolve(Buffer.concat(chunks).toString('latin1')));
    socket.once('error', reject);
  });
}

function slowChunkedRequest(path: string, chunks: readonly Buffer[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port });
    const received: Buffer[] = [];

    socket.setTimeout(2_000, () => socket.destroy(new Error('Slow HTTP request timed out')));
    socket.on('data', (chunk: Buffer) => received.push(chunk));
    socket.once('end', () => resolve(Buffer.concat(received).toString('latin1')));
    socket.once('error', reject);
    socket.once('connect', async () => {
      socket.write(`POST ${path} HTTP/1.1\r\nHost: ${host}\r\nTransfer-Encoding: chunked\r\nConnection: keep-alive\r\n\r\n`);

      for (const chunk of chunks) {
        socket.write(`${chunk.byteLength.toString(16)}\r\n`);
        socket.write(chunk);
        socket.write('\r\n');
        await delay(10);
        if (socket.destroyed) return;
      }

      socket.end('0\r\n\r\n');
    });
  });
}

function parseJson(response: TestResponse): any {
  return JSON.parse(response.body.toString('utf8'));
}

before(async () => {
  const router = new Router();
  const body = createBodyReader({ limit: bodyLimit });
  const inspect = async ({ request: incoming, response, params, signal, url }: Parameters<Parameters<Router['route']>[2]>[0]) => {
    const payload = await body.read(incoming, { signal });
    json(response, {
      method: incoming.method,
      value: params.value,
      query: Object.fromEntries(url.searchParams),
      contentType: incoming.headers['content-type'],
      repeatedHeader: incoming.headers['x-repeated'],
      cookie: incoming.headers.cookie,
      bodyBase64: payload.toString('base64'),
    });
  };

  for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'PURGE']) {
    router.route(method, '/inspect/:value', inspect);
  }

  router.post('/json', async ({ request: incoming, response, signal }) => {
    json(response, await body.json(incoming, { signal }));
  });

  router.get('/cookies', ({ request: incoming, response }) => {
    response.setHeader('set-cookie', ['theme=dark; Path=/; SameSite=Lax', 'session=test; Path=/; HttpOnly']);
    json(response, { cookie: incoming.headers.cookie });
  });

  router.get('/framing', ({ response }) => {
    send(response, 'abc', {
      headers: {
        'content-length': 99,
        trailer: 'x-checksum',
        'transfer-encoding': 'chunked',
      },
    });
  });

  router.get('/framing-error', () => {
    throw new HttpError(418, 'Framing error', {
      headers: {
        'content-length': 99,
        trailer: 'x-checksum',
        'transfer-encoding': 'chunked',
      },
    });
  });

  const createdServer = createServer(
    {
      headersTimeout: 2_000,
      requestTimeout: 2_000,
      keepAliveTimeout: 1_000,
      maxHeaderSize: 1_024,
    },
    createHttpHandler(router),
  );
  server = createdServer;

  await new Promise<void>((resolve, reject) => {
    createdServer.once('error', reject);
    createdServer.listen(0, host, () => {
      createdServer.off('error', reject);
      port = (createdServer.address() as AddressInfo).port;
      resolve();
    });
  });
});

after(async () => {
  if (server === undefined) return;
  const runningServer = server;

  await new Promise<void>((resolve, reject) => {
    runningServer.close((error) => (error === undefined ? resolve() : reject(error)));
    runningServer.closeAllConnections();
  });
});

describe('HTTP black-box integration', () => {
  it('reads route params, queries, headers, cookies, and binary bodies', async () => {
    const body = Buffer.from([0, 1, 2, 127, 128, 255]);
    const response = await request('POST', '/inspect/Miro%20V?lang=bg&draft=true', {
      headers: {
        'content-type': 'application/octet-stream',
        cookie: 'theme=dark; session=abc123',
        'x-repeated': ['first', 'second'],
      },
      chunks: [body],
    });
    const result = parseJson(response);

    assert.equal(response.statusCode, 200);
    assert.equal(result.value, 'Miro V');
    assert.deepEqual(result.query, { lang: 'bg', draft: 'true' });
    assert.equal(result.contentType, 'application/octet-stream');
    assert.equal(result.repeatedHeader, 'first, second');
    assert.equal(result.cookie, 'theme=dark; session=abc123');
    assert.equal(result.bodyBase64, body.toString('base64'));
  });

  it('dispatches standard and custom methods', async () => {
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'PURGE']) {
      const response = await request(method, '/inspect/method');
      assert.equal(response.statusCode, 200, method);
      assert.equal(parseJson(response).method, method);
    }
  });

  it('handles HEAD, OPTIONS, and method-not-allowed responses', async () => {
    const head = await request('HEAD', '/inspect/head');
    const options = await request('OPTIONS', '/inspect/options');
    const rejected = await request('TRACE', '/inspect/trace');

    assert.equal(head.statusCode, 200);
    assert.equal(head.body.byteLength, 0);
    assert.equal(options.statusCode, 204);
    assert.match(options.headers.allow ?? '', /PURGE/);
    assert.equal(rejected.statusCode, 405);
    assert.match(rejected.headers.allow ?? '', /OPTIONS/);
  });

  it('parses JSON and rejects malformed, empty, and mistyped JSON', async () => {
    const accepted = await request('POST', '/json', {
      headers: { 'content-type': 'application/json; charset=utf-8' },
      chunks: ['{"works":true}'],
    });
    const malformed = await request('POST', '/json', {
      headers: { 'content-type': 'application/json' },
      chunks: ['{"nope":'],
    });
    const empty = await request('POST', '/json', {
      headers: { 'content-type': 'application/json' },
    });
    const mistyped = await request('POST', '/json', {
      headers: { 'content-type': 'text/plain' },
      chunks: ['{}'],
    });

    assert.deepEqual(parseJson(accepted), { works: true });
    assert.equal(malformed.statusCode, 400);
    assert.equal(parseJson(malformed).error.code, 'INVALID_JSON');
    assert.equal(empty.statusCode, 400);
    assert.equal(parseJson(empty).error.code, 'EMPTY_JSON_BODY');
    assert.equal(mistyped.statusCode, 415);
    assert.equal(parseJson(mistyped).error.code, 'UNSUPPORTED_CONTENT_TYPE');
  });

  it('rejects oversized declared and chunked bodies', async () => {
    const oversized = Buffer.alloc(bodyLimit + 1, 'x');
    const declared = await request('POST', '/inspect/large', {
      headers: { 'content-length': String(oversized.byteLength) },
      chunks: [oversized],
    });
    const chunked = await request('POST', '/inspect/large', {
      chunks: [oversized.subarray(0, 32), oversized.subarray(32)],
    });

    assert.equal(declared.statusCode, 413);
    assert.equal(parseJson(declared).error.code, 'BODY_TOO_LARGE');
    assert.equal(chunked.statusCode, 413);
    assert.equal(parseJson(chunked).error.code, 'BODY_TOO_LARGE');
  });

  it('checks size before content type and closes rejected body connections', async () => {
    const oversized = Buffer.alloc(bodyLimit + 1, 'x');
    const response = await request('POST', '/json', {
      headers: {
        'content-type': 'text/plain',
        'content-length': String(oversized.byteLength),
      },
      chunks: [oversized],
    });

    assert.equal(response.statusCode, 413);
    assert.equal(response.headers.connection, 'close');
    assert.equal(parseJson(response).error.code, 'BODY_TOO_LARGE');
  });

  it('does not process a pipelined request after rejecting a body', async () => {
    const response = await rawRequest(
      `POST /json HTTP/1.1\r\nHost: ${host}\r\nContent-Type: text/plain\r\nContent-Length: 2\r\nConnection: keep-alive\r\n\r\n{}GET /cookies HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`,
    );

    assert.match(response, /^HTTP\/1\.1 415 /);
    assert.equal(response.match(/HTTP\/1\.1/g)?.length, 1);
    assert.match(response, /\r\nConnection: close\r\n/i);
  });

  it('closes unread bodies on missing routes, rejected methods, and automatic OPTIONS', async () => {
    const cases = [
      { requestLine: 'POST /missing', statusCode: 404 },
      { requestLine: 'POST /cookies', statusCode: 405 },
      { requestLine: 'OPTIONS /cookies', statusCode: 204 },
    ] as const;

    for (const { requestLine, statusCode } of cases) {
      const response = await rawRequest(
        `${requestLine} HTTP/1.1\r\nHost: ${host}\r\nContent-Length: 2\r\nConnection: keep-alive\r\n\r\n{}GET /cookies HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`,
      );

      assert.match(response, new RegExp(`^HTTP/1\\.1 ${statusCode} `), requestLine);
      assert.equal(response.match(/HTTP\/1\.1/g)?.length, 1, requestLine);
      assert.match(response, /\r\nConnection: close\r\n/i, requestLine);
    }
  });

  it('bounds a slow chunked body and closes its connection', async () => {
    const response = await slowChunkedRequest('/inspect/slow', [Buffer.alloc(32, 'a'), Buffer.alloc(33, 'b')]);

    assert.match(response, /^HTTP\/1\.1 413 /);
    assert.match(response, /\r\nConnection: close\r\n/i);
  });

  it('reads Cookie and emits independent Set-Cookie headers', async () => {
    const response = await request('GET', '/cookies', {
      headers: { cookie: 'locale=bg; theme=dark' },
    });

    assert.equal(parseJson(response).cookie, 'locale=bg; theme=dark');
    assert.deepEqual(response.headers['set-cookie'], ['theme=dark; Path=/; SameSite=Lax', 'session=test; Path=/; HttpOnly']);
  });

  it('lets Node reject header overflow and ambiguous body framing', async () => {
    const overflow = await rawRequest(`GET /inspect/header HTTP/1.1\r\nHost: ${host}\r\nX-Huge: ${'x'.repeat(2_000)}\r\nConnection: close\r\n\r\n`);
    const ambiguous = await rawRequest(`POST /inspect/framing HTTP/1.1\r\nHost: ${host}\r\nContent-Length: 4\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n0\r\n\r\n`);

    assert.match(overflow, /^HTTP\/1\.1 431 /);
    assert.match(ambiguous, /^HTTP\/1\.1 400 /);
  });

  it('rejects raw fragments instead of routing their normalized path', async () => {
    for (const path of ['/cookies#admin', '/cookies?view=public#admin']) {
      const response = await request('GET', path);
      assert.equal(response.statusCode, 400, path);
      assert.equal(parseJson(response).error.code, 'INVALID_REQUEST_URL', path);
    }
  });

  it('owns response framing for normal and error responses', async () => {
    const regular = await request('GET', '/framing');
    const error = await request('GET', '/framing-error');

    assert.equal(regular.body.toString(), 'abc');
    assert.equal(regular.headers['content-length'], String(regular.body.byteLength));
    assert.equal(regular.headers['transfer-encoding'], undefined);
    assert.equal(regular.headers.trailer, undefined);

    assert.equal(error.statusCode, 418);
    assert.equal(error.headers['content-length'], String(error.body.byteLength));
    assert.equal(error.headers['transfer-encoding'], undefined);
    assert.equal(error.headers.trailer, undefined);
  });
});
