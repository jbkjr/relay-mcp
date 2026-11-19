/** Resources acquired by one live test, including ones acquired while it is being cancelled. */
export class LiveScope {
  readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  private stops: { stop: () => Promise<void>; priority: number }[] = [];
  private closing?: Promise<void>;

  defer(stop: () => void | Promise<void>, priority = 0): () => Promise<void> {
    let stopped: Promise<void> | undefined;
    const once = () => stopped ??= Promise.resolve().then(stop);
    this.stops.push({ stop: once, priority });
    // An allocation already in progress may finish after the deadline. It must still be stopped.
    if (this.signal.aborted) void once().catch(() => {});
    return once;
  }

  wait<T>(work: Promise<T>): Promise<T> {
    if (this.signal.aborted) {
      void work.catch(() => {});
      return Promise.reject(this.signal.reason);
    }
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.signal.removeEventListener("abort", abort);
        reject(this.signal.reason);
      };
      this.signal.addEventListener("abort", abort, { once: true });
      work.then(resolve, reject).finally(() => this.signal.removeEventListener("abort", abort));
    });
  }

  close(): Promise<void> {
    return this.closing ??= (async () => {
      this.controller.abort(new Error("live test ended"));
      const errors: unknown[] = [];
      // LIFO: turns stop before their brokers, models and environment authorities.
      while (this.stops.length) {
        this.stops.sort((a, b) => a.priority - b.priority);
        try { await this.stops.pop()!.stop(); } catch (err) { errors.push(err); }
      }
      if (errors.length) throw new AggregateError(errors, "live test cleanup failed");
    })();
  }
}
