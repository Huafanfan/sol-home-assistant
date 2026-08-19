import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export interface SatelliteProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly failedToStart: boolean;
}

export interface SatelliteTransport {
  readonly output: AsyncIterable<Uint8Array>;
  readonly exit: Promise<SatelliteProcessExit>;
  write(frame: Uint8Array): Promise<void>;
  closeInput(): void;
  terminate(): void;
}

export type SatelliteProcessMetric =
  | { readonly type: "process_started" }
  | { readonly type: "diagnostic_bytes"; readonly byteCount: number }
  | {
      readonly type: "process_exited";
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
      readonly failedToStart: boolean;
    };

export interface SpawnSatelliteProcessOptions {
  readonly executablePath: string;
  readonly arguments?: readonly string[];
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly recordMetric?: (metric: SatelliteProcessMetric) => void;
  readonly spawnProcess?: typeof spawn;
}

export class ChildProcessSatelliteTransport implements SatelliteTransport {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #recordMetric: (metric: SatelliteProcessMetric) => void;

  public readonly output: AsyncIterable<Uint8Array>;
  public readonly exit: Promise<SatelliteProcessExit>;

  public constructor(options: SpawnSatelliteProcessOptions) {
    this.#recordMetric = options.recordMetric ?? (() => undefined);
    const spawnProcess = options.spawnProcess ?? spawn;
    this.#child = spawnProcess(
      options.executablePath,
      [...(options.arguments ?? [])],
      {
        env: sanitizeSatelliteEnvironment(options.environment ?? process.env),
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.output = this.#child.stdout;
    this.#recordMetric({ type: "process_started" });

    this.#child.stderr.on("data", (chunk: Buffer) => {
      this.#recordMetric({
        type: "diagnostic_bytes",
        byteCount: chunk.byteLength,
      });
    });
    this.#child.stderr.resume();

    this.exit = new Promise<SatelliteProcessExit>((resolve) => {
      let failedToStart = false;
      this.#child.once("error", () => {
        failedToStart = true;
      });
      this.#child.once("close", (code, signal) => {
        const result = { code, signal, failedToStart };
        this.#recordMetric({ type: "process_exited", ...result });
        resolve(result);
      });
    });
  }

  public write(frame: Uint8Array): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.#child.stdin.destroyed || !this.#child.stdin.writable) {
        reject(new Error("Satellite process input is closed"));
        return;
      }
      this.#child.stdin.write(frame, (error) => {
        if (error !== null && error !== undefined) {
          reject(new Error("Satellite process write failed"));
          return;
        }
        resolve();
      });
    });
  }

  public closeInput(): void {
    this.#child.stdin.end();
  }

  public terminate(): void {
    if (this.#child.exitCode === null && this.#child.signalCode === null) {
      this.#child.kill("SIGTERM");
    }
  }
}

export function sanitizeSatelliteEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "TMPDIR", "LANG", "LC_ALL"] as const) {
    const value = source[key];
    if (value !== undefined) {
      environment[key] = value;
    }
  }
  return environment;
}
