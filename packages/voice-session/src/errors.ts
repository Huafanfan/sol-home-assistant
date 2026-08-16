import type { FailureCode, SessionStage } from "./contracts.js";

export class VoiceSessionError extends Error {
  public constructor(
    public readonly code: FailureCode,
    message: string,
  ) {
    super(message);
    this.name = "VoiceSessionError";
  }
}

export class SessionInterruptedError extends Error {
  public constructor() {
    super("Voice session interrupted");
    this.name = "SessionInterruptedError";
  }
}

export class SessionTimeoutError extends Error {
  public constructor() {
    super("Voice session adapter timed out");
    this.name = "SessionTimeoutError";
  }
}

export function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new SessionInterruptedError();
  }
}

export function raceWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new SessionInterruptedError());
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new SessionInterruptedError());
    signal.addEventListener("abort", onAbort, { once: true });

    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export function raceWithAbortAndTimeout<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new SessionTimeoutError());
    }, timeoutMs);

    raceWithAbort(promise, signal).then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

export function failureCodeFor(
  stage: SessionStage,
  error: unknown,
): FailureCode {
  if (error instanceof VoiceSessionError) {
    return error.code;
  }

  if (error instanceof SessionTimeoutError) {
    switch (stage) {
      case "asr":
        return "asr_timeout";
      case "router":
        return "router_timeout";
      case "reasoner":
        return "reasoner_timeout";
      case "tts":
        return "tts_timeout";
      case "playback":
        return "playback_timeout";
      case "session":
        return "unknown_error";
    }
  }

  switch (stage) {
    case "asr":
      return "asr_error";
    case "router":
      return "router_error";
    case "reasoner":
      return "reasoner_error";
    case "tts":
      return "tts_error";
    case "playback":
      return "playback_error";
    case "session":
      return "unknown_error";
  }
}
