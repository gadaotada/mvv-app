import { fork } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { createHistogram, performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

function integer(name, fallback, minimum) {
  const value = Number(process.env[name] ?? fallback);

  if (!Number.isSafeInteger(value) || value < minimum) throw new TypeError(`${name} must be an integer greater than or equal to ${minimum}`);

  return value;
}

function positiveInteger(name, fallback) {
  return integer(name, fallback, 1);
}

function optionalPositiveInteger(name) {
  if (process.env[name] === undefined) return undefined;

  return positiveInteger(name, 1);
}

async function readResidentMemoryBytes(pid) {
  const status = await readFile(`/proc/${pid}/status`, 'utf8');
  const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);

  if (match === null) throw new Error(`Cannot read VmRSS for PID ${pid}`);

  return Number(match[1]) * 1_024;
}

function formatMebibytes(bytes) {
  return `${(bytes / 1_048_576).toFixed(2)} MiB`;
}

function formatMilliseconds(milliseconds) {
  return `${milliseconds < 1 ? milliseconds.toFixed(3) : milliseconds.toFixed(2)} ms`;
}

function formatRate(value) {
  return Math.round(value).toLocaleString('en-US');
}

function recordMilliseconds(histogram, milliseconds) {
  histogram.record(Math.max(1, Math.round(milliseconds * 1_000)));
}

function histogramMilliseconds(histogram, percentile) {
  return histogram.percentile(percentile) / 1_000;
}

function printLatency(name, histogram) {
  console.log(
    `${name}: avg ${formatMilliseconds(histogram.mean / 1_000)}, p50 ${formatMilliseconds(histogramMilliseconds(histogram, 50))}, p95 ${formatMilliseconds(
      histogramMilliseconds(histogram, 95),
    )}, p99 ${formatMilliseconds(histogramMilliseconds(histogram, 99))}, max ${formatMilliseconds(histogram.max / 1_000)}`,
  );
}

function percentile(sortedValues, value) {
  if (sortedValues.length === 0) return 0;

  const index = Math.max(0, Math.ceil((value / 100) * sortedValues.length) - 1);
  return sortedValues[index];
}

async function runMemoryMonitor() {
  const pid = positiveInteger('BENCH_MONITOR_PID', 1);
  const intervalMs = positiveInteger('BENCH_MEMORY_INTERVAL_MS', 100);
  const samples = [];
  let monitorError;

  async function sample() {
    try {
      samples.push({
        elapsedMs: performance.now(),
        rssBytes: await readResidentMemoryBytes(pid),
      });
    } catch (error) {
      monitorError = error instanceof Error ? error.message : String(error);
    }
  }

  await sample();
  if (monitorError !== undefined) {
    await new Promise((resolve) => {
      process.send?.({ type: 'ready', error: monitorError }, resolve);
    });
    process.disconnect();
    return;
  }

  process.send?.({ type: 'ready' });
  let sampling = Promise.resolve();
  const timer = setInterval(() => {
    sampling = sampling.then(sample);
  }, intervalMs);
  timer.unref();

  await new Promise((resolve) => {
    process.once('message', (message) => {
      if (typeof message === 'object' && message !== null && message.type === 'stop') resolve();
    });
    process.once('disconnect', resolve);
  });

  clearInterval(timer);
  await sampling;
  await sample();

  if (!process.connected) return;

  await new Promise((resolve) => {
    process.send?.({ type: 'result', samples, error: monitorError }, resolve);
  });
  process.disconnect();
}

async function startMemoryMonitor(pid, intervalMs) {
  const child = fork(fileURLToPath(import.meta.url), ['--memory-monitor'], {
    env: {
      ...process.env,
      BENCH_MONITOR_PID: String(pid),
      BENCH_MEMORY_INTERVAL_MS: String(intervalMs),
    },
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  const { promise: ready, resolve: resolveReady, reject: rejectReady } = Promise.withResolvers();
  const { promise: result, resolve: resolveResult, reject: rejectResult } = Promise.withResolvers();
  let isReady = false;
  let isFinished = false;

  child.on('message', (message) => {
    if (typeof message !== 'object' || message === null) return;

    if (message.type === 'ready') {
      if (message.error !== undefined) {
        const error = new Error(message.error);
        isFinished = true;
        rejectReady(error);
        resolveResult({ type: 'result', samples: [], error: message.error });
        return;
      }

      isReady = true;
      resolveReady();
    }

    if (message.type === 'result') {
      isFinished = true;
      resolveResult(message);
    }
  });
  child.once('error', (error) => {
    if (!isReady) rejectReady(error);
    if (!isFinished) rejectResult(error);
  });
  child.once('exit', (code, signal) => {
    if (isFinished) return;

    const error = new Error(`Memory monitor exited before returning results (${signal ?? `code ${code ?? 'unknown'}`})`);
    if (!isReady) rejectReady(error);
    rejectResult(error);
  });

  await ready;

  return {
    async stop() {
      child.send({ type: 'stop' });
      return result;
    },
  };
}

async function runBenchmark() {
  const target = new URL(process.env.BENCH_URL ?? 'http://127.0.0.1:3000/health');
  const connections = positiveInteger('BENCH_CONNECTIONS', 100);
  const durationSeconds = positiveInteger('BENCH_DURATION', 10);
  const warmupSeconds = integer('BENCH_WARMUP', 3, 0);
  const workersPerConnection = positiveInteger('BENCH_WORKERS_PER_CONNECTION', 1);
  const requestTimeoutMs = positiveInteger('BENCH_REQUEST_TIMEOUT_MS', 30_000);
  const monitoredPid = optionalPositiveInteger('BENCH_PID');
  const memoryIntervalMs = monitoredPid === undefined ? undefined : positiveInteger('BENCH_MEMORY_INTERVAL_MS', 100);
  const transport = target.protocol === 'https:' ? https : http;

  if (target.protocol !== 'http:' && target.protocol !== 'https:') throw new TypeError('BENCH_URL must use http or https');

  const agent = new transport.Agent({
    keepAlive: true,
    maxSockets: connections,
  });

  function request() {
    const queuedAt = performance.now();
    let socketAssignedAt = queuedAt;

    return new Promise((resolve, reject) => {
      const outgoing = transport.get(target, { agent }, (incoming) => {
        let responseBytes = 0;

        incoming.on('data', (chunk) => {
          responseBytes += chunk.byteLength;
        });
        incoming.once('end', () => {
          const completedAt = performance.now();
          resolve({
            endToEndLatency: completedAt - queuedAt,
            queueLatency: socketAssignedAt - queuedAt,
            requestLatency: completedAt - socketAssignedAt,
            responseBytes,
            statusCode: incoming.statusCode ?? 0,
          });
        });
      });

      outgoing.once('socket', () => {
        socketAssignedAt = performance.now();
      });
      outgoing.setTimeout(requestTimeoutMs, () => outgoing.destroy(new Error(`Request exceeded ${requestTimeoutMs}ms`)));
      outgoing.once('error', reject);
    });
  }

  try {
    const response = await request();
    if (response.statusCode < 200 || response.statusCode >= 300) throw new Error(`Target returned HTTP ${response.statusCode}`);
  } catch (error) {
    agent.destroy();
    console.error(`Cannot reach benchmark target: ${target}`);
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
    return;
  }

  const workerCount = connections * workersPerConnection;
  console.log(`Benchmarking ${target}`);
  console.log(`${connections} maximum sockets, ${workerCount.toLocaleString('en-US')} request loop(s), ${durationSeconds}s measured, ${warmupSeconds}s warmup`);
  console.log(`Per-request timeout: ${requestTimeoutMs.toLocaleString('en-US')}ms`);
  if (workersPerConnection > 1) console.log('Latency is split so time waiting in the client socket queue is not mistaken for server/network latency.');

  async function runWorkers(seconds, onResult, onFailure) {
    const deadline = performance.now() + seconds * 1_000;

    async function worker() {
      while (performance.now() < deadline) {
        try {
          onResult(await request());
        } catch (error) {
          onFailure(error);
        }
      }
    }

    const startedAt = performance.now();
    await Promise.all(Array.from({ length: workerCount }, worker));
    return (performance.now() - startedAt) / 1_000;
  }

  if (warmupSeconds > 0) {
    process.stdout.write('Warming up... ');
    let warmupFailures = 0;
    await runWorkers(
      warmupSeconds,
      () => undefined,
      () => {
        warmupFailures += 1;
      },
    );
    console.log(warmupFailures === 0 ? 'done' : `done (${warmupFailures.toLocaleString('en-US')} failed request(s))`);
  }

  let memoryMonitor;
  if (monitoredPid !== undefined && memoryIntervalMs !== undefined) {
    try {
      memoryMonitor = await startMemoryMonitor(monitoredPid, memoryIntervalMs);
      console.log(`App RSS sampled in a child process for PID ${monitoredPid} every ${memoryIntervalMs}ms`);
    } catch (error) {
      agent.destroy();
      console.error(`Cannot monitor app memory for PID ${monitoredPid}`);
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
      return;
    }
  }

  const requestLatency = createHistogram();
  const queueLatency = createHistogram();
  const endToEndLatency = createHistogram();
  const statusCodes = new Map();
  let completed = 0;
  let failed = 0;
  let responseBytes = 0;

  const elapsedSeconds = await runWorkers(
    durationSeconds,
    (result) => {
      completed += 1;
      responseBytes += result.responseBytes;
      recordMilliseconds(requestLatency, result.requestLatency);
      recordMilliseconds(queueLatency, result.queueLatency);
      recordMilliseconds(endToEndLatency, result.endToEndLatency);
      statusCodes.set(result.statusCode, (statusCodes.get(result.statusCode) ?? 0) + 1);
    },
    () => {
      failed += 1;
    },
  );

  const memoryResult = memoryMonitor === undefined ? undefined : await memoryMonitor.stop();
  agent.destroy();

  console.log('');
  console.log('Results');
  console.log(`${formatRate(completed / elapsedSeconds)} requests/sec over ${elapsedSeconds.toFixed(2)}s`);
  console.log(`${completed.toLocaleString('en-US')} completed, ${failed.toLocaleString('en-US')} failed, ${(responseBytes / 1_048_576).toFixed(2)} MiB response bodies`);
  console.log(`Status codes: ${[...statusCodes].sort(([left], [right]) => left - right).map(([code, count]) => `${code}=${count}`).join(', ') || 'none'}`);

  if (completed > 0) {
    printLatency('Request latency (socket assigned → body received)', requestLatency);
    printLatency('Client queue delay', queueLatency);
    printLatency('End-to-end latency (request created → body received)', endToEndLatency);
  }

  if (memoryResult !== undefined) {
    if (memoryResult.error !== undefined) {
      console.error(`App memory monitoring failed: ${memoryResult.error}`);
      process.exitCode = 1;
    }

    if (memoryResult.samples.length > 0) {
      const rssValues = memoryResult.samples.map((sample) => sample.rssBytes);
      const sortedRss = [...rssValues].sort((left, right) => left - right);
      const totalRss = rssValues.reduce((total, value) => total + value, 0);
      const first = memoryResult.samples[0];
      const last = memoryResult.samples.at(-1);
      const sampledDurationMs = first === undefined || last === undefined ? 0 : last.elapsedMs - first.elapsedMs;
      const effectiveIntervalMs = memoryResult.samples.length < 2 ? 0 : sampledDurationMs / (memoryResult.samples.length - 1);

      console.log(
        `App RSS: start ${formatMebibytes(rssValues[0])}, avg ${formatMebibytes(totalRss / rssValues.length)}, p95 ${formatMebibytes(
          percentile(sortedRss, 95),
        )}, max ${formatMebibytes(sortedRss.at(-1))}, end ${formatMebibytes(rssValues.at(-1))}`,
      );
      console.log(
        `RSS change: end-start ${formatMebibytes(rssValues.at(-1) - rssValues[0])}, peak-start ${formatMebibytes(sortedRss.at(-1) - rssValues[0])}; ${
          memoryResult.samples.length
        } samples at ${effectiveIntervalMs.toFixed(1)}ms effective interval`,
      );
    }
  }

  if (failed > 0 || [...statusCodes].some(([code]) => code < 200 || code >= 300)) process.exitCode = 1;
}

if (process.argv[2] === '--memory-monitor') {
  await runMemoryMonitor();
} else {
  await runBenchmark();
}
