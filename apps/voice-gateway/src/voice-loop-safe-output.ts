import type { SessionOutcome } from "../../../packages/voice-session/src/index.js";

export function formatVoiceTurnOutcome(
  outcome: SessionOutcome | undefined,
): string {
  if (outcome === undefined) {
    return "idle";
  }
  switch (outcome.kind) {
    case "completed":
      return "completed";
    case "interrupted":
      return `interrupted stage=${outcome.stage}`;
    case "failed":
      return `failed stage=${outcome.stage} code=${outcome.code}`;
  }
}

export interface VoiceLoopCaptureSummary {
  readonly frameCount: number;
  readonly byteCount: number;
  readonly durationMs: number;
  readonly reason: number;
}

export function formatVoiceCaptureSummary(
  summary: VoiceLoopCaptureSummary,
): string {
  return [
    `frames=${summary.frameCount}`,
    `bytes=${summary.byteCount}`,
    `duration_ms=${summary.durationMs}`,
    `reason=${summary.reason}`,
  ].join(" ");
}
