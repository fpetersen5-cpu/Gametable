/** Small counting semaphore so ten thinking models do not stampede a key. */
export class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly limit: number) {
    if (limit < 1) throw new Error('semaphore limit must be at least 1');
  }

  async run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    if (this.active >= this.limit) {
      await new Promise<void>((resolve, reject) => {
        const resume = () => {
          signal?.removeEventListener('abort', abort);
          resolve();
        };
        const abort = () => {
          const index = this.queue.indexOf(resume);
          if (index !== -1) this.queue.splice(index, 1);
          reject(signal?.reason);
        };
        this.queue.push(resume);
        signal?.addEventListener('abort', abort, { once: true });
      });
    } else {
      this.active++;
    }
    try {
      signal?.throwIfAborted();
      return await task();
    } finally {
      // Transfer the slot directly to the next waiter, including cancelled wakeups.
      const next = this.queue.shift();
      if (next) next();
      else this.active--;
    }
  }

  get pending(): number {
    return this.queue.length;
  }
}
