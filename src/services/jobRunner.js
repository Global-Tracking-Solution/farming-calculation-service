import {Worker} from 'worker_threads';

// Runs each analysis in a worker thread with a concurrency limit, a queue and a timeout.
const workerFile = new URL('../workers/analyze.worker.js', import.meta.url);

export class RunnerError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // 'BUSY' | 'TIMEOUT' | 'FAILED'
  }
}

// At most `maxConcurrent` analyses run at once, `maxQueue` more may wait, the rest are refused (503).
export const createRunner = ({maxConcurrent = 2, maxQueue = 20, timeoutMs = 120000} = {}) => {
  let running = 0;
  const queue = [];

  const start = (job, resolve, reject) => {
    running += 1;
    let settled = false;
    const worker = new Worker(workerFile, {workerData: job});
    const finish = fn => value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      running -= 1;
      fn(value);
      const next = queue.shift();
      if (next) start(...next);
    };
    const done = finish(resolve);
    const fail = finish(reject);
    const timer = setTimeout(() => fail(new RunnerError('TIMEOUT', `Analysis took longer than ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);

    worker.once('message', message =>
      message.ok ? done(message.result) : fail(new RunnerError('FAILED', message.message)));
    worker.once('error', error => fail(new RunnerError('FAILED', error.message)));
    worker.once('exit', code => {
      if (!settled && code !== 0) fail(new RunnerError('FAILED', `Worker stopped (code ${code})`));
    });
  };

  return {
    run: job =>
      new Promise((resolve, reject) => {
        if (running < maxConcurrent) {
          start(job, resolve, reject);
        } else if (queue.length < maxQueue) {
          queue.push([job, resolve, reject]);
        } else {
          reject(new RunnerError('BUSY', 'Server is busy, retry shortly'));
        }
      }),
    stats: () => ({running, queued: queue.length}),
  };
};
