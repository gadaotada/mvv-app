import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';

import { createHttpHandler } from './handler.js';
import { send } from './response.js';
import { Router } from './router.js';
import { createStaticAssetHandler } from './static.js';

it('serves static assets safely through the router', async (context) => {
  const publicPath = await mkdtemp(join(tmpdir(), 'mvv-static-'));
  context.after(async () => rm(publicPath, { recursive: true, force: true }));

  await writeFile(join(publicPath, 'hello.txt'), 'hello');
  await writeFile(join(publicPath, 'unknown.asset'), Buffer.from([0, 1, 2]));
  await mkdir(join(publicPath, 'directory'));

  const router = new Router();
  router.get('/health', ({ response }) => send(response, 'healthy'));
  router.get(
    '/*assetPath',
    createStaticAssetHandler({
      publicPath,
      cacheControl: 'public, max-age=60',
    }),
  );

  await using server = createServer(createHttpHandler(router));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Static asset test server did not bind a TCP port');
  const origin = `http://127.0.0.1:${address.port}`;

  const text = await fetch(`${origin}/hello.txt`);
  assert.equal(text.status, 200);
  assert.equal(text.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(text.headers.get('cache-control'), 'public, max-age=60');
  assert.equal(text.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(await text.text(), 'hello');

  const head = await fetch(`${origin}/hello.txt`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), '5');
  assert.equal(await head.text(), '');

  const unknown = await fetch(`${origin}/unknown.asset`);
  assert.equal(unknown.headers.get('content-type'), 'application/octet-stream');
  assert.deepEqual(new Uint8Array(await unknown.arrayBuffer()), new Uint8Array([0, 1, 2]));

  const health = await fetch(`${origin}/health`);
  assert.equal(await health.text(), 'healthy');

  for (const path of ['/missing.txt', '/directory']) {
    const missing = await fetch(`${origin}${path}`);
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: { code: 'STATIC_ASSET_NOT_FOUND', message: 'Static asset not found' } });
  }
});

it('validates static asset configuration eagerly', () => {
  assert.throws(() => createStaticAssetHandler({ publicPath: '' }), /public path/);
  assert.throws(() => createStaticAssetHandler({ publicPath: '.', cacheControl: '' }), /cache control/);
});
