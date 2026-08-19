export type VoiceLoopCommandHandler = (command: string) => Promise<void>;

/**
 * Keeps normal terminal commands ordered while allowing an explicit interrupt
 * to preempt a stop command that is waiting for provider and playback work.
 */
export class VoiceLoopCommandScheduler {
  #queue: Promise<void> = Promise.resolve();

  public constructor(
    private readonly handle: VoiceLoopCommandHandler,
    private readonly onFailure: (command: string) => void,
  ) {}

  public dispatch(command: string): void {
    if (command === "interrupt") {
      void this.#run(command);
      return;
    }
    this.#queue = this.#queue.then(() => this.#run(command));
  }

  public async drain(): Promise<void> {
    await this.#queue;
  }

  async #run(command: string): Promise<void> {
    try {
      await this.handle(command);
    } catch {
      this.onFailure(command);
    }
  }
}
