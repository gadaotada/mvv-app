import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { createConnection } from 'node:net';
import { it } from 'node:test';

import { createGracefulShutdown } from './shutdown.js';

it('gracefully closes a server and runs hooks once', async () => {
  let listening = true;
  const server = {
    close: (callback: (error?: Error) => void) => {
      listening = false;
      queueMicrotask(() => callback());
    },
    closeAllConnections: () => undefined,
    on: () => server,
    off: () => server,
    get listening() {
      return listening;
    },
  } as unknown as Server;
  let hookCalls = 0;
  const shutdown = createGracefulShutdown(server, {
    hooks: [
      () => {
        hookCalls += 1;
      },
    ],
  });

  await Promise.all([shutdown.shutdown('test'), shutdown.shutdown('duplicate')]);

  assert.equal(server.listening, false);
  assert.equal(hookCalls, 1);
});

function hangingServer(): Server {
  return {
    close: () => undefined,
    closeAllConnections: () => undefined,
    on: () => hangingServer,
    off: () => hangingServer,
  } as unknown as Server;
}

it('uses one deadline for a hanging close and still invokes every cleanup hook', async () => {
  const calls: string[] = [];
  const shutdown = createGracefulShutdown(hangingServer(), {
    timeoutMs: 20,
    hooks: [
      () => {
        calls.push('mandatory');
      },
      async (signal) => {
        calls.push('hanging');
        if (signal.aborted) {
          calls.push('stopped');
          return;
        }

        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
        calls.push('stopped');
      },
    ],
  });

  await assert.rejects(shutdown.shutdown(), /exceeded 20ms/);
  assert.deepEqual(calls, ['mandatory', 'hanging', 'stopped']);
});

it('aborts active cleanup before a timed-out shutdown settles and reports rejected hooks', async () => {
  const calls: string[] = [];
  const server = {
    close: (callback: (error?: Error) => void) => queueMicrotask(() => callback()),
    closeAllConnections: () => undefined,
    on: () => server,
    off: () => server,
  } as unknown as Server;
  let cleanupActive = false;
  let cleanupSignal: AbortSignal | undefined;
  const hanging = createGracefulShutdown(server, {
    timeoutMs: 20,
    hooks: [
      async (signal) => {
        cleanupActive = true;
        cleanupSignal = signal;
        if (signal.aborted) {
          cleanupActive = false;
          return;
        }

        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
        cleanupActive = false;
      },
    ],
  });
  await assert.rejects(hanging.shutdown(), /exceeded 20ms/);
  assert.equal(cleanupSignal?.aborted, true);
  assert.equal(cleanupActive, false);

  const rejected = createGracefulShutdown(server, {
    hooks: [
      () => {
        calls.push('rejected');
        throw new Error('cleanup failed');
      },
      () => {
        calls.push('later');
      },
    ],
  });
  await assert.rejects(rejected.shutdown(), AggregateError);
  assert.deepEqual(calls, ['rejected', 'later']);
});

it('force-closes a hanging active request at the shutdown deadline', async () => {
  let markRequestStarted!: () => void;
  const requestStarted = new Promise<void>((resolve) => {
    markRequestStarted = resolve;
  });
  const server = createServer((_request, _response) => markRequestStarted());
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  assert(address !== null && typeof address !== 'string');

  const socket = createConnection(address.port, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.once('connect', () => {
      socket.write('GET / HTTP/1.1\r\nHost: localhost\r\n\r\n');
      resolve();
    });
  });
  await requestStarted;

  const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
  const shutdown = createGracefulShutdown(server, { timeoutMs: 20 });

  await assert.rejects(shutdown.shutdown(), /exceeded 20ms/);
  await closed;
  assert.equal(socket.destroyed, true);
});

it('coalesces multiple simultaneous installed signals into one shutdown', async () => {
  let closes = 0;
  let hooks = 0;
  const server = {
    close: (callback: (error?: Error) => void) => {
      closes += 1;
      setImmediate(() => callback());
    },
    closeAllConnections: () => undefined,
    on: () => server,
    off: () => server,
  } as unknown as Server;
  const shutdown = createGracefulShutdown(server, {
    hooks: [
      () => {
        hooks += 1;
      },
    ],
  });
  const existingInterrupt = new Set(process.listeners('SIGINT'));
  const existingTerminate = new Set(process.listeners('SIGTERM'));
  const uninstall = shutdown.install();
  const interrupt = process.listeners('SIGINT').find((listener) => !existingInterrupt.has(listener));
  const terminate = process.listeners('SIGTERM').find((listener) => !existingTerminate.has(listener));
  assert(interrupt !== undefined);
  assert(terminate !== undefined);

  interrupt('SIGINT');
  terminate('SIGTERM');
  await shutdown.shutdown();
  uninstall();

  assert.equal(closes, 1);
  assert.equal(hooks, 1);
});
