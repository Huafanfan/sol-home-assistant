import { resolve } from "node:path";

import {
  ScriptedAsr,
  StaticReasoner,
  StaticRouter,
  StaticTts,
  VoiceSession,
} from "../packages/voice-session/src/index.js";
import { MacosSatelliteClient } from "../apps/voice-gateway/src/satellite/macos-satellite-client.js";
import { ChildProcessSatelliteTransport } from "../apps/voice-gateway/src/satellite/process-transport.js";
import { SatelliteMessageKind } from "../apps/voice-gateway/src/satellite/protocol.js";

export async function checkMacosSatellitePlayback(
  executablePath = resolve(
    process.cwd(),
    "apps/voice-satellite-macos/.build/debug/sol-voice-satellite",
  ),
): Promise<{
  readonly chunks: number;
  readonly playbackFrames: number;
  readonly pcmBytes: number;
  readonly elapsedMs: number;
  readonly exitCode: number;
}> {
  const transport = new ChildProcessSatelliteTransport({ executablePath });
  let playbackFrames = 0;
  const client = new MacosSatelliteClient({
    transport,
    operationTimeoutMs: 3_000,
    recordMetric: (metric) => {
      if (
        metric.type === "frame_sent" &&
        metric.kind === SatelliteMessageKind.playAudio
      ) {
        playbackFrames += 1;
      }
    },
  });
  const pcm = new Uint8Array(3_200); // 100 ms of silent 16 kHz mono int16.
  const chunks = 10;

  try {
    const permission = await client.initialize();
    if (permission !== "authorized") {
      throw new Error("Microphone permission is not authorized");
    }
    const session = new VoiceSession({
      sessionId: "silent-playback-check",
      asr: new ScriptedAsr("offline transcript"),
      router: new StaticRouter({ kind: "direct", text: "offline answer" }),
      reasoner: new StaticReasoner([]),
      tts: new StaticTts(Array.from({ length: chunks }, () => pcm)),
      playback: client,
    });
    const startedAt = performance.now();
    const completion = session.begin();
    session.pushAudio(Uint8Array.of(1, 2));
    session.endAudio();
    const outcome = await completion;
    const elapsedMs = Math.round(performance.now() - startedAt);
    if (outcome.kind !== "completed") {
      throw new Error("Satellite playback session did not complete");
    }
    if (playbackFrames > 2 || elapsedMs > 1_600) {
      throw new Error("Satellite playback continuity budget exceeded");
    }
    await client.shutdown();
    const exit = await transport.exit;
    if (exit.code !== 0 || exit.failedToStart) {
      throw new Error("Satellite playback process did not exit cleanly");
    }
    return {
      chunks,
      playbackFrames,
      pcmBytes: pcm.byteLength * chunks,
      elapsedMs,
      exitCode: exit.code,
    };
  } catch (error) {
    await client.shutdown().catch(() => transport.terminate());
    throw error;
  }
}

if (process.argv[1]?.endsWith("check-macos-satellite-playback.js") === true) {
  try {
    const report = await checkMacosSatellitePlayback();
    console.log(JSON.stringify({ status: "ok", ...report }));
  } catch {
    console.error(JSON.stringify({ status: "failed" }));
    process.exitCode = 1;
  }
}
