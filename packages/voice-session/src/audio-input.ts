import { VoiceSessionError } from "./errors.js";

/**
 * In-memory, single-consumer input queue. It deliberately has no persistence
 * and is closed whenever a session finishes or is interrupted.
 */
export class SessionAudioInput implements AsyncIterable<Uint8Array> {
  readonly #queuedFrames: Uint8Array[] = [];
  #waiter: ((frame: Uint8Array | undefined) => void) | undefined;
  #closed = false;

  public push(frame: Uint8Array): void {
    if (this.#closed) {
      throw new VoiceSessionError(
        "audio_after_input_closed",
        "Cannot accept audio after the session input has closed",
      );
    }

    const waiter = this.#waiter;
    if (waiter !== undefined) {
      this.#waiter = undefined;
      waiter(frame);
      return;
    }

    this.#queuedFrames.push(frame);
  }

  public close(): void {
    if (this.#closed) {
      return;
    }

    this.#closed = true;
    const waiter = this.#waiter;
    this.#waiter = undefined;
    waiter?.(undefined);
  }

  public async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    while (true) {
      const queuedFrame = this.#queuedFrames.shift();
      if (queuedFrame !== undefined) {
        yield queuedFrame;
        continue;
      }

      if (this.#closed) {
        return;
      }

      const frame = await new Promise<Uint8Array | undefined>((resolve) => {
        this.#waiter = resolve;
      });

      if (frame === undefined) {
        return;
      }

      yield frame;
    }
  }
}
