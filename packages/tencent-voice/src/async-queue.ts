import { TencentVoiceProviderError } from "./errors.js";

type QueueWaiter<T> = {
  readonly resolve: (value: IteratorResult<T>) => void;
  readonly reject: (error: unknown) => void;
};

export class AsyncQueue<T> {
  readonly #items: T[] = [];
  readonly #waiters: QueueWaiter<T>[] = [];
  #closed = false;
  #failure: unknown;

  public push(item: T): void {
    if (this.#closed || this.#failure !== undefined) {
      return;
    }
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter.resolve({ done: false, value: item });
      return;
    }
    this.#items.push(item);
  }

  public close(): void {
    if (this.#closed || this.#failure !== undefined) {
      return;
    }
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter.resolve({ done: true, value: undefined });
    }
  }

  public fail(error: unknown): void {
    if (this.#closed || this.#failure !== undefined) {
      return;
    }
    this.#failure = error;
    for (const waiter of this.#waiters.splice(0)) {
      waiter.reject(error);
    }
  }

  public next(signal: AbortSignal): Promise<IteratorResult<T>> {
    if (this.#failure !== undefined) {
      return Promise.reject(this.#failure);
    }
    const item = this.#items.shift();
    if (item !== undefined) {
      return Promise.resolve({ done: false, value: item });
    }
    if (this.#closed) {
      return Promise.resolve({ done: true, value: undefined });
    }
    if (signal.aborted) {
      return Promise.reject(new TencentVoiceProviderError("cancelled"));
    }

    return new Promise<IteratorResult<T>>((resolve, reject) => {
      const waiter: QueueWaiter<T> = {
        resolve: (value) => {
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        reject: (error) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      };
      const onAbort = () => {
        const index = this.#waiters.indexOf(waiter);
        if (index >= 0) {
          this.#waiters.splice(index, 1);
        }
        reject(new TencentVoiceProviderError("cancelled"));
      };
      this.#waiters.push(waiter);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
