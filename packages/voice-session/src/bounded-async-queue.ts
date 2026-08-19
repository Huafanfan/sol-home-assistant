interface PendingRead<T> {
  readonly resolve: (result: IteratorResult<T>) => void;
  readonly reject: (error: unknown) => void;
}

interface PendingWrite<T> {
  readonly value: T;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
  readonly cleanup: () => void;
}

/**
 * Small in-memory producer/consumer queue used to keep provider streams moving
 * while downstream speech and playback apply bounded backpressure.
 */
export class BoundedAsyncQueue<T> implements AsyncIterable<T> {
  readonly #values: T[] = [];
  readonly #readers: PendingRead<T>[] = [];
  readonly #writers: PendingWrite<T>[] = [];
  #closed = false;
  #failure: unknown;

  public constructor(private readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error("Queue capacity must be a positive integer");
    }
  }

  public push(value: T, signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      return Promise.reject(signal.reason);
    }
    if (this.#failure !== undefined) {
      return Promise.reject(this.#failure);
    }
    if (this.#closed) {
      return Promise.reject(new Error("Queue is closed"));
    }

    const reader = this.#readers.shift();
    if (reader !== undefined) {
      reader.resolve({ done: false, value });
      return Promise.resolve();
    }
    if (this.#values.length < this.capacity) {
      this.#values.push(value);
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        const index = this.#writers.indexOf(writer);
        if (index >= 0) {
          this.#writers.splice(index, 1);
        }
        reject(signal.reason);
      };
      const writer: PendingWrite<T> = {
        value,
        resolve,
        reject,
        cleanup: () => signal.removeEventListener("abort", onAbort),
      };
      this.#writers.push(writer);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  public close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#rejectWriters(new Error("Queue is closed"));
    if (this.#values.length === 0) {
      for (const reader of this.#readers.splice(0)) {
        reader.resolve({ done: true, value: undefined });
      }
    }
  }

  public fail(error: unknown): void {
    if (this.#failure !== undefined) {
      return;
    }
    this.#failure = error;
    this.#closed = true;
    this.#rejectWriters(error);
    if (this.#values.length === 0) {
      for (const reader of this.#readers.splice(0)) {
        reader.reject(error);
      }
    }
  }

  public [Symbol.asyncIterator](): AsyncIterator<T> {
    return { next: () => this.#next() };
  }

  #next(): Promise<IteratorResult<T>> {
    const value = this.#values.shift();
    if (value !== undefined) {
      this.#promoteWriter();
      return Promise.resolve({ done: false, value });
    }
    if (this.#failure !== undefined) {
      return Promise.reject(this.#failure);
    }
    if (this.#closed) {
      return Promise.resolve({ done: true, value: undefined });
    }
    return new Promise<IteratorResult<T>>((resolve, reject) => {
      this.#readers.push({ resolve, reject });
    });
  }

  #promoteWriter(): void {
    const writer = this.#writers.shift();
    if (writer === undefined) {
      return;
    }
    writer.cleanup();
    this.#values.push(writer.value);
    writer.resolve();
  }

  #rejectWriters(error: unknown): void {
    for (const writer of this.#writers.splice(0)) {
      writer.cleanup();
      writer.reject(error);
    }
  }
}
