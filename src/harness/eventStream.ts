export class EventStream<T> implements AsyncIterable<T> {
  private readonly queued: T[] = [];
  private readonly waiters: Array<(value: IteratorResult<T>) => void> = [];
  private ended = false;

  push(value: T): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value, done: false });
      return;
    }
    this.queued.push(value);
  }

  end(): void {
    this.ended = true;
    for (;;) {
      const waiter = this.waiters.shift();
      if (!waiter) break;
      waiter({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.queued.length > 0) {
          const value = this.queued.shift() as T;
          return Promise.resolve({ value, done: false });
        }
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise<IteratorResult<T>>((resolve) => this.waiters.push(resolve));
      }
    };
  }
}
