import { readFile, stat } from 'node:fs/promises';
import type { OutgoingHttpHeaders } from 'node:http';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { HttpError } from './errors.js';
import { send } from './response.js';
import type { RouteHandler } from './router.js';

export interface StaticAssetHandlerOptions {
  readonly publicPath: string | URL;
  readonly cacheControl?: string;
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.avif': 'image/avif',
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.htm': 'text/html; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.xml': 'application/xml; charset=utf-8',
};

const DEFAULT_CONTENT_TYPE = 'application/octet-stream';
const DEFAULT_CACHE_CONTROL = 'public, max-age=300';

function isMissingFileError(error: unknown): boolean {
  if (!(error instanceof Error) || !('code' in error)) return false;
  return error.code === 'ENOENT' || error.code === 'ENOTDIR' || error.code === 'EISDIR';
}

function resolvePublicPath(publicPath: string | URL): string {
  if (publicPath instanceof URL) return resolve(fileURLToPath(publicPath));
  if (typeof publicPath !== 'string' || publicPath.length === 0) throw new TypeError('Static asset public path must be a non-empty path or file URL');
  return resolve(publicPath);
}

function resolveAssetPath(publicPath: string, assetPath: string): string {
  if (assetPath.length === 0 || assetPath.includes('\0')) throw new HttpError(404, 'Static asset not found', { code: 'STATIC_ASSET_NOT_FOUND' });

  const filePath = resolve(publicPath, assetPath);
  const relativePath = relative(publicPath, filePath);

  if (relativePath.length === 0 || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new HttpError(404, 'Static asset not found', { code: 'STATIC_ASSET_NOT_FOUND' });
  }

  return filePath;
}

export function createStaticAssetHandler(options: StaticAssetHandlerOptions): RouteHandler {
  if (options === null || typeof options !== 'object') throw new TypeError('Static asset options must be an object');

  const publicPath = resolvePublicPath(options.publicPath);
  const cacheControl = options.cacheControl ?? DEFAULT_CACHE_CONTROL;

  if (typeof cacheControl !== 'string' || cacheControl.length === 0) throw new TypeError('Static asset cache control must be a non-empty string');

  return async ({ params, response, signal }) => {
    const assetPath = params.assetPath;
    if (assetPath === undefined) throw new HttpError(500, 'Static asset route must define an assetPath wildcard', { code: 'INVALID_STATIC_ASSET_ROUTE', expose: false });

    const filePath = resolveAssetPath(publicPath, assetPath);
    let body: Buffer;

    try {
      const metadata = await stat(filePath);
      if (!metadata.isFile()) throw new HttpError(404, 'Static asset not found', { code: 'STATIC_ASSET_NOT_FOUND' });
      body = await readFile(filePath, { signal });
    } catch (error) {
      if (error instanceof HttpError || !isMissingFileError(error)) throw error;
      throw new HttpError(404, 'Static asset not found', { code: 'STATIC_ASSET_NOT_FOUND' });
    }

    const headers: OutgoingHttpHeaders = {
      'cache-control': cacheControl,
      'x-content-type-options': 'nosniff',
    };

    send(response, body, {
      headers,
      contentType: CONTENT_TYPES[extname(filePath).toLowerCase()] ?? DEFAULT_CONTENT_TYPE,
    });
  };
}
