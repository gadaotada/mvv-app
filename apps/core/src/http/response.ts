import type { OutgoingHttpHeaders, ServerResponse } from 'node:http';

import { safeJsonStringify } from '../utils/json.js';

export type ResponseHeaders = Readonly<OutgoingHttpHeaders>;

export interface SendOptions {
  readonly statusCode?: number;
  readonly contentType?: string;
  readonly headers?: ResponseHeaders;
}

function applyHeaders(response: ServerResponse, headers: ResponseHeaders): void {
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) response.setHeader(name, value);
  }
}

function removeTransferFraming(response: ServerResponse): void {
  response.removeHeader('transfer-encoding');
  response.removeHeader('trailer');
}

export function send(response: ServerResponse, body: string | Uint8Array, options: SendOptions = {}): void {
  response.statusCode = options.statusCode ?? 200;
  applyHeaders(response, options.headers ?? {});
  removeTransferFraming(response);

  if (options.contentType !== undefined && !response.hasHeader('content-type')) response.setHeader('content-type', options.contentType);

  response.setHeader('content-length', typeof body === 'string' ? Buffer.byteLength(body) : body.byteLength);

  response.end(body);
}

export function html(response: ServerResponse, body: string, statusCode = 200, headers: ResponseHeaders = {}): void {
  send(response, body, {
    statusCode,
    headers,
    contentType: 'text/html; charset=utf-8',
  });
}

export function json(response: ServerResponse, value: unknown, statusCode = 200, headers: ResponseHeaders = {}): void {
  const body = safeJsonStringify(value);

  if (!body.ok) throw body.error;

  send(response, body.value, {
    statusCode,
    headers,
    contentType: 'application/json; charset=utf-8',
  });
}

export function noContent(response: ServerResponse, headers: ResponseHeaders = {}): void {
  response.statusCode = 204;
  applyHeaders(response, headers);
  removeTransferFraming(response);
  response.removeHeader('content-length');
  response.end();
}

export function redirect(response: ServerResponse, location: string, statusCode: 301 | 302 | 303 | 307 | 308 = 303): void {
  response.statusCode = statusCode;
  removeTransferFraming(response);
  response.setHeader('location', location);
  response.setHeader('content-length', 0);
  response.end();
}
