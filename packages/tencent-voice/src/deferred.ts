export interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}

export function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  // Some operations have several gates rejected by one socket failure. Mark
  // each promise handled even when an earlier gate prevents awaiting it.
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}
