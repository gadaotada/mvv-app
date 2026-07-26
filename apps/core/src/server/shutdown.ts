import type { Server } from 'node:http';
import type { Socket } from 'node:net';

export type ShutdownHook = (signal: AbortSignal) => void | Promise<void>;

export interface GracefulShutdownOptions {
  readonly timeoutMs?: number;
  /**
   * Hooks run after HTTP connection draining, within the time remaining before
   * the overall deadline. Hooks must check an already-aborted signal and stop
   * promptly if the signal is aborted while they are running.
   */
  readonly hooks?: readonly ShutdownHook[];
}

export interface GracefulShutdown {
  shutdown(reason?: string): Promise<void>;
  install(signals?: readonly NodeJS.Signals[]): () => void;
}

export function createGracefulShutdown(server: Server, options: GracefulShutdownOptions = {}): GracefulShutdown {
  const timeoutMs = options.timeoutMs ?? 10_000;

  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new RangeError('Shutdown timeout must be a positive safe integer');

  let pending: Promise<void> | undefined;
  const sockets = new Set<Socket>();
  const trackSocket = (socket: Socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  };
  server.on('connection', trackSocket);

  const shutdown = (reason = 'manual'): Promise<void> => {
    pending ??= (async () => {
      const timeoutError = new Error(`Graceful shutdown exceeded ${timeoutMs}ms (${reason})`);
      const controller = new AbortController();
      let timedOut = false;
      let reachDeadline!: () => void;
      const deadline = new Promise<void>((resolve) => {
        reachDeadline = resolve;
      });
      const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort(timeoutError);
        server.closeAllConnections();
        for (const socket of sockets) socket.destroy(timeoutError);
        reachDeadline();
      }, timeoutMs);
      timeout.unref();

      let closeError: unknown;
      try {
        const close = new Promise<void>((resolve) => {
          server.close((error) => {
            if (error !== undefined) closeError = error;
            resolve();
          });
        });

        await Promise.race([close, deadline]);

        const hookResults = Promise.allSettled(
          (options.hooks ?? []).map(async (hook) => {
            await hook(controller.signal);
          }),
        );
        const result = await Promise.race([hookResults, deadline.then(() => undefined)]);

        if (timedOut || result === undefined) throw timeoutError;

        const rejectedHooks = result.filter((item): item is PromiseRejectedResult => item.status === 'rejected');
        if (closeError !== undefined || rejectedHooks.length > 0) {
          throw new AggregateError(
            [closeError, ...rejectedHooks.map((item) => item.reason)].filter((error) => error !== undefined),
            'Graceful shutdown failed',
          );
        }
      } finally {
        clearTimeout(timeout);
        server.off('connection', trackSocket);
      }
    })();

    return pending;
  };

  const install = (signals: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM']): (() => void) => {
    const listeners = new Map<NodeJS.Signals, () => void>();

    for (const signal of signals) {
      const listener = () => {
        shutdown(signal).catch((error: unknown) => {
          console.error(`Shutdown failed after ${signal}`, error);
          process.exitCode = 1;
        });
      };

      listeners.set(signal, listener);
      process.once(signal, listener);
    }

    return () => {
      for (const [signal, listener] of listeners) {
        process.off(signal, listener);
      }
    };
  };

  return { shutdown, install };
}
