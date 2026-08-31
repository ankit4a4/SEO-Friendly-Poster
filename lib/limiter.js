// Tiny semaphore: caps how many async jobs run at the same time, queues the rest.
// Used in two places with two DIFFERENT purposes:
//   1) server.js  -> caps how many SITES are processed at once (throughput lever)
//   2) services/ai.js -> caps how many AI provider calls are in flight across the
//      WHOLE app at once (safety lever - keeps free-tier keys from being hammered
//      no matter how many sites are running in parallel)
class Limiter {
  constructor(max) {
    this.max = Math.max(1, Number(max) || 1);
    this.active = 0;
    this.queue = [];
  }

  async run(fn) {
    if (this.active >= this.max) {
      await new Promise((resolve) => this.queue.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      const next = this.queue.shift();
      if (next) next();
    }
  }
}

module.exports = { Limiter };
