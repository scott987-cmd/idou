// One account's background publisher and receiver share the CLI/key budget.
// Cancellation removes queued work immediately; started work must drain itself.
export class WikiCloudWork {
  constructor() { this.queue = []; this.active = false; }
  run(operation, { signal } = {}) {
    if (signal?.aborted) return Promise.reject(new Error("knowledge work cancelled"));
    if (this.queue.length >= 4) return Promise.reject(new Error("knowledge work queue full"));
    return new Promise((resolve, reject) => {
      const row = { operation, resolve, reject, signal, cancel: () => { this.queue = this.queue.filter(item => item !== row); reject(new Error("knowledge work cancelled")); } };
      signal?.addEventListener("abort", row.cancel, { once: true }); this.queue.push(row); this.next();
    });
  }
  next() {
    if (this.active) return;
    const row = this.queue.shift(); if (!row) return;
    row.signal?.removeEventListener("abort", row.cancel); this.active = true;
    Promise.resolve().then(() => { row.signal?.throwIfAborted(); return row.operation(); }).then(row.resolve, row.reject).finally(() => { this.active = false; this.next(); });
  }
}
