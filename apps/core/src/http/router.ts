import type { IncomingMessage, ServerResponse } from 'node:http';

import { HttpError } from './errors.js';
import { hasUnreadRequestBody, markConnectionForClosure } from './request.js';
import { noContent } from './response.js';

export type RouteParams = Readonly<Record<string, string>>;

export interface RouteContext {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly url: URL;
  readonly params: RouteParams;
  readonly signal: AbortSignal;
}

export type RouteHandler = (context: RouteContext) => void | Promise<void>;

export interface RouterOptions {
  readonly handlerTimeoutMs?: number;
}

type RouteToken = { readonly type: 'static'; readonly value: string } | { readonly type: 'parameter'; readonly name: string } | { readonly type: 'wildcard'; readonly name: string };

interface Route {
  readonly method: string;
  readonly pattern: string;
  readonly tokens: readonly RouteToken[];
  readonly handler: RouteHandler;
}

interface ParsedRequestUrl {
  readonly url: URL;
  readonly segments: readonly string[];
  readonly staticKey: string;
}

class RequestRouteContext implements RouteContext {
  private controller: AbortController | undefined;
  private aborted = false;
  private abortReason: unknown;

  constructor(
    readonly request: IncomingMessage,
    readonly response: ServerResponse,
    readonly url: URL,
    readonly params: RouteParams,
  ) {}

  get signal(): AbortSignal {
    this.controller ??= new AbortController();
    if (this.aborted && !this.controller.signal.aborted) this.controller.abort(this.abortReason);

    return this.controller.signal;
  }

  abort(reason: unknown): void {
    if (this.aborted) return;

    this.aborted = true;
    this.abortReason = reason;
    this.controller?.abort(reason);
  }
}

const validMethod = /^[A-Z][A-Z0-9-]*$/;
const validParameter = /^[A-Za-z_][A-Za-z0-9_]*$/;
const emptyParams: RouteParams = Object.freeze(Object.create(null) as Record<string, string>);

function splitPath(path: string): string[] {
  if (!path.startsWith('/')) throw new TypeError(`Route path must start with '/': ${path}`);

  return path === '/' ? [] : path.slice(1).split('/');
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch (error) {
    throw new HttpError(400, 'Request path contains invalid encoding', {
      code: 'INVALID_PATH_ENCODING',
      cause: error,
    });
  }
}

function compilePattern(pattern: string): readonly RouteToken[] {
  const names = new Set<string>();

  return splitPath(pattern).map((segment, index, segments): RouteToken => {
    const prefix = segment[0];

    if (prefix !== ':' && prefix !== '*') return { type: 'static', value: decodeSegment(segment) };

    const name = segment.slice(1);

    if (!validParameter.test(name)) throw new TypeError(`Invalid route parameter in pattern: ${pattern}`);

    if (names.has(name)) throw new TypeError(`Duplicate route parameter '${name}' in pattern: ${pattern}`);

    names.add(name);

    if (prefix === '*') {
      if (index !== segments.length - 1) throw new TypeError(`Wildcard must be the final route segment: ${pattern}`);

      return { type: 'wildcard', name };
    }

    return { type: 'parameter', name };
  });
}

function matchRoute(tokens: readonly RouteToken[], segments: readonly string[]): RouteParams | undefined {
  let params: Record<string, string> | undefined;
  let index = 0;

  for (const token of tokens) {
    if (token.type === 'wildcard') {
      params ??= Object.create(null) as Record<string, string>;
      params[token.name] = segments.slice(index).join('/');
      index = segments.length;
      break;
    }

    const segment = segments[index];
    if (segment === undefined) return undefined;

    if (token.type === 'static' && token.value !== segment) return undefined;

    if (token.type === 'parameter') {
      params ??= Object.create(null) as Record<string, string>;
      params[token.name] = segment;
    }

    index += 1;
  }

  if (index !== segments.length) return undefined;

  return params === undefined ? emptyParams : Object.freeze(params);
}

function createStaticKey(segments: readonly string[]): string {
  let key = '';

  for (const segment of segments) {
    key += `${segment.length}:${segment}`;
  }

  return key;
}

function parseRequestUrl(request: IncomingMessage): ParsedRequestUrl {
  const rawUrl = request.url;

  if (rawUrl === undefined || !rawUrl.startsWith('/') || rawUrl.startsWith('//')) throw new HttpError(400, 'Request URL must use origin form', { code: 'INVALID_REQUEST_URL' });
  if (rawUrl.includes('#')) throw new HttpError(400, 'Request URL must not contain a fragment', { code: 'INVALID_REQUEST_URL' });

  const queryIndex = rawUrl.indexOf('?');
  const rawPath = queryIndex === -1 ? rawUrl : rawUrl.slice(0, queryIndex);
  if (rawPath.includes('\\') || rawPath.includes('//') || /%2f|%5c/i.test(rawPath)) {
    throw new HttpError(400, 'Request path is not canonical', { code: 'NONCANONICAL_PATH' });
  }

  const rawSegments = splitPath(rawPath);
  const segments = new Array<string>(rawSegments.length);

  for (let index = 0; index < rawSegments.length; index += 1) {
    const decoded = decodeSegment(rawSegments[index] as string);
    if (decoded === '.' || decoded === '..') throw new HttpError(400, 'Request path is not canonical', { code: 'NONCANONICAL_PATH' });

    segments[index] = decoded;
  }

  try {
    return {
      url: new URL(rawUrl, 'http://localhost'),
      segments,
      staticKey: createStaticKey(segments),
    };
  } catch (error) {
    throw new HttpError(400, 'Request URL is invalid', {
      code: 'INVALID_REQUEST_URL',
      cause: error,
    });
  }
}

export class Router {
  private readonly routes: Route[] = [];
  private readonly staticRoutes = new Map<string, Map<string, Route>>();
  private readonly dynamicRoutes: Route[] = [];
  private readonly handlerTimeoutMs: number;

  constructor(options: RouterOptions = {}) {
    this.handlerTimeoutMs = options.handlerTimeoutMs ?? 30_000;

    if (!Number.isSafeInteger(this.handlerTimeoutMs) || this.handlerTimeoutMs <= 0) {
      throw new RangeError('Handler timeout must be a positive safe integer');
    }
  }

  route(method: string, pattern: string, handler: RouteHandler): this {
    const normalizedMethod = method.toUpperCase();

    if (!validMethod.test(normalizedMethod)) throw new TypeError(`Invalid HTTP method: ${method}`);

    if (this.routes.some((route) => route.method === normalizedMethod && route.pattern === pattern)) throw new TypeError(`Duplicate route: ${normalizedMethod} ${pattern}`);

    const tokens = compilePattern(pattern);
    const route = {
      method: normalizedMethod,
      pattern,
      tokens,
      handler,
    };

    if (tokens.every((token) => token.type === 'static')) {
      const key = createStaticKey(tokens.map((token) => token.value));
      const routesByMethod = this.staticRoutes.get(key) ?? new Map<string, Route>();

      if (routesByMethod.has(normalizedMethod)) throw new TypeError(`Duplicate route: ${normalizedMethod} ${pattern}`);

      routesByMethod.set(normalizedMethod, route);
      this.staticRoutes.set(key, routesByMethod);
    } else {
      this.dynamicRoutes.push(route);
    }

    this.routes.push(route);

    return this;
  }

  get(pattern: string, handler: RouteHandler): this {
    return this.route('GET', pattern, handler);
  }

  post(pattern: string, handler: RouteHandler): this {
    return this.route('POST', pattern, handler);
  }

  put(pattern: string, handler: RouteHandler): this {
    return this.route('PUT', pattern, handler);
  }

  patch(pattern: string, handler: RouteHandler): this {
    return this.route('PATCH', pattern, handler);
  }

  delete(pattern: string, handler: RouteHandler): this {
    return this.route('DELETE', pattern, handler);
  }

  dispatch(request: IncomingMessage, response: ServerResponse): void | Promise<void> {
    const { url, segments, staticKey } = parseRequestUrl(request);
    const method = (request.method ?? 'GET').toUpperCase();
    const staticRoutes = this.staticRoutes.get(staticKey);
    const staticMatch = staticRoutes?.get(method);

    if (staticMatch !== undefined) return this.invoke(staticMatch, emptyParams, request, response, url);

    for (const route of this.dynamicRoutes) {
      if (route.method !== method) continue;

      const params = matchRoute(route.tokens, segments);
      if (params !== undefined) return this.invoke(route, params, request, response, url);
    }

    if (method === 'HEAD') {
      const staticGet = staticRoutes?.get('GET');
      if (staticGet !== undefined) return this.invoke(staticGet, emptyParams, request, response, url);

      for (const route of this.dynamicRoutes) {
        if (route.method !== 'GET') continue;

        const params = matchRoute(route.tokens, segments);
        if (params !== undefined) return this.invoke(route, params, request, response, url);
      }
    }

    let allowed: Set<string> | undefined;

    if (staticRoutes !== undefined) {
      allowed = new Set(staticRoutes.keys());
    }

    for (const route of this.dynamicRoutes) {
      if (matchRoute(route.tokens, segments) === undefined) continue;

      allowed ??= new Set<string>();
      allowed.add(route.method);
    }

    if (allowed === undefined) throw new HttpError(404, 'Route not found', { code: 'ROUTE_NOT_FOUND' });

    if (allowed.has('GET')) allowed.add('HEAD');

    allowed.add('OPTIONS');
    const allow = [...allowed].sort().join(', ');

    if (method === 'OPTIONS') {
      if (hasUnreadRequestBody(request)) markConnectionForClosure(response);

      noContent(response, { allow });
      return;
    }

    throw new HttpError(405, 'Method not allowed', {
      code: 'METHOD_NOT_ALLOWED',
      headers: { allow },
    });
  }

  private invoke(route: Route, params: RouteParams, request: IncomingMessage, response: ServerResponse, url: URL): void | Promise<void> {
    const context = new RequestRouteContext(request, response, url, params);
    const pending = route.handler(context);

    if (pending === undefined) {
      this.assertResponseEnded(response);
      return;
    }

    return this.finishAsyncHandler(Promise.resolve(pending), context, request, response);
  }

  private async finishAsyncHandler(pending: Promise<void>, context: RequestRouteContext, request: IncomingMessage, response: ServerResponse): Promise<void> {
    let rejectAborted!: (reason: unknown) => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAborted = reject;
    });
    const abort = (reason: unknown) => {
      context.abort(reason);
      rejectAborted(reason);
    };
    const onRequestAborted = () => abort(new Error('Client connection closed'));

    request.once('aborted', onRequestAborted);
    if (request.aborted) onRequestAborted();

    const timeout = setTimeout(() => {
      abort(new HttpError(504, 'Route handler timed out', { code: 'HANDLER_TIMEOUT' }));
    }, this.handlerTimeoutMs);
    timeout.unref();

    try {
      await Promise.race([pending, aborted]);
    } finally {
      clearTimeout(timeout);
      request.off('aborted', onRequestAborted);
    }

    this.assertResponseEnded(response);
  }

  private assertResponseEnded(response: ServerResponse): void {
    if (!response.writableEnded) {
      throw new HttpError(500, 'Route handler did not end the response', { code: 'INCOMPLETE_RESPONSE' });
    }
  }
}
