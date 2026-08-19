import { resolve } from "node:path";
import { createInterface } from "node:readline";

import { NoopMetrics } from "../../../packages/voice-session/src/index.js";
import { VoiceGateway } from "./development-gateway.js";
import { ReasoningRouter } from "./reasoning-router.js";
import { VoiceLoopCommandScheduler } from "./voice-loop-command-scheduler.js";
import {
  formatVoiceCaptureSummary,
  formatVoiceTurnOutcome,
} from "./voice-loop-safe-output.js";
import { createTencentVoiceGatewayAdapters } from "./config/tencent-voice.js";
import { createTextReasonerFromEnvironment } from "./config/text-reasoner.js";
import { MacosSatelliteClient } from "./satellite/macos-satellite-client.js";
import { MacosSatelliteRuntime } from "./satellite/macos-satellite-runtime.js";
import { ChildProcessSatelliteTransport } from "./satellite/process-transport.js";

const executablePath = resolve(
  process.cwd(),
  "apps/voice-satellite-macos/.build/debug/sol-voice-satellite",
);
const transport = new ChildProcessSatelliteTransport({ executablePath });
const client = new MacosSatelliteClient({ transport });
const voice = createTencentVoiceGatewayAdapters();
const gateway = new VoiceGateway({
  ...voice,
  router: new ReasoningRouter(),
  reasoner: createTextReasonerFromEnvironment(),
  playback: client,
  metrics: new NoopMetrics(),
});
let captureSummary = {
  frameCount: 0,
  byteCount: 0,
  durationMs: 0,
};
const runtime = new MacosSatelliteRuntime({
  client,
  gateway,
  recordMetric: (metric) => {
    if (metric.type === "state_changed" && metric.to === "capturing") {
      captureSummary = { frameCount: 0, byteCount: 0, durationMs: 0 };
    } else if (metric.type === "audio_received") {
      captureSummary = {
        frameCount: metric.frameCount,
        byteCount: metric.byteCount,
        durationMs: metric.durationMs,
      };
    } else if (metric.type === "capture_stopped") {
      process.stderr.write(
        `SOL_CAPTURE_SUMMARY ${formatVoiceCaptureSummary({
          ...captureSummary,
          reason: metric.reason,
        })}\n`,
      );
    }
  },
});
const terminal = createInterface({ input: process.stdin, output: process.stderr });

let closed = false;
const commandScheduler = new VoiceLoopCommandScheduler(
  handleCommand,
  reportCommandFailure,
);

try {
  const state = await runtime.initialize();
  process.stderr.write(`SOL_VOICE_STATE ${state}\n`);
  if (state === "permission_blocked") {
    process.stderr.write("SOL_MICROPHONE_PERMISSION_BLOCKED\n");
  } else {
    process.stderr.write("SOL_COMMANDS start stop interrupt status quit\n");
  }

  terminal.on("line", (line) => {
    const command = line.trim().toLowerCase();
    commandScheduler.dispatch(command);
  });
  terminal.once("close", () => {
    void commandScheduler.drain().then(() => closeRuntime());
  });
} catch {
  process.stderr.write("SOL_VOICE_LOOP_FAILED\n");
  await closeRuntime();
  process.exitCode = 1;
}

async function handleCommand(command: string): Promise<void> {
  switch (command) {
    case "start":
      await runtime.beginCapture();
      process.stderr.write("SOL_VOICE_STATE capturing\n");
      return;
    case "stop": {
      const outcome = await runtime.endCapture();
      process.stderr.write(`SOL_TURN_OUTCOME ${formatVoiceTurnOutcome(outcome)}\n`);
      return;
    }
    case "interrupt": {
      const outcome = await runtime.interrupt();
      process.stderr.write(`SOL_TURN_OUTCOME ${formatVoiceTurnOutcome(outcome)}\n`);
      return;
    }
    case "status":
      process.stderr.write(`SOL_VOICE_STATE ${runtime.state}\n`);
      return;
    case "quit":
      terminal.close();
      return;
    case "":
      return;
    default:
      process.stderr.write("SOL_COMMAND_UNKNOWN\n");
  }
}

function isKnownCommand(command: string): boolean {
  return ["start", "stop", "interrupt", "status", "quit", ""].includes(
    command,
  );
}

function reportCommandFailure(command: string): void {
  const safeCommand = isKnownCommand(command) ? command : "unknown";
  process.stderr.write(
    `SOL_COMMAND_FAILED ${safeCommand} runtime=${runtime.state} satellite=${client.state}\n`,
  );
}

async function closeRuntime(): Promise<void> {
  if (closed) {
    return;
  }
  closed = true;
  await runtime.shutdown().catch(() => transport.terminate());
  process.stderr.write("SOL_VOICE_STATE stopped\n");
}
