import { createServer } from 'node:http';

import { createEnvironment } from '@mvv/core/config';
import { createHttpHandler, Router, send } from '@mvv/core/http';
import { createGracefulShutdown } from '@mvv/core/server';

const env = createEnvironment();
const host = env.string('SITE_HOST', { fallback: '127.0.0.1' });
const port = env.integer('SITE_PORT', { fallback: 3000, min: 1, max: 65_535 });

export const router = new Router({ handlerTimeoutMs: 10_000 });
const healthBody = '{"status":"ok"}';
const healthHeaders = { 'cache-control': 'no-store' } as const;

router.get('/health', async ({ response }) => {
  send(response, healthBody, {
    headers: healthHeaders,
    contentType: 'application/json; charset=utf-8',
  });
});

export const server = createServer(
  {
    headersTimeout: 10_000,
    requestTimeout: 15_000,
    keepAliveTimeout: 5_000,
  },
  createHttpHandler(router),
);

if (import.meta.main) {
  const shutdown = createGracefulShutdown(server);
  const removeShutdownHandlers = shutdown.install();

  server.once('close', removeShutdownHandlers);
  server.once('error', (error) => {
    console.error('Site server failed', error);
    process.exitCode = 1;
  });

  server.listen(port, host, () => {
    console.log(`Site server listening at http://${host}:${port} (PID ${process.pid})`);
  });
}
