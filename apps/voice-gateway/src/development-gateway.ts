import { randomUUID } from "node:crypto";

import {
  VoiceSession,
  type VoiceSessionDependencies,
} from "../../../packages/voice-session/src/index.js";

export type VoiceGatewayDependencies = Omit<
  VoiceSessionDependencies,
  "sessionId"
> & {
  readonly createSessionId?: () => string;
};

/**
 * Composition root for the future containerized Gateway. It owns provider
 * dependencies and gives each short-lived session a random identifier without
 * exposing any credential or provider concern to a Voice Satellite.
 */
export class VoiceGateway {
  public constructor(
    private readonly dependencies: VoiceGatewayDependencies,
  ) {}

  public createSession(): VoiceSession {
    const { createSessionId = randomUUID, ...sessionDependencies } =
      this.dependencies;

    return new VoiceSession({
      ...sessionDependencies,
      sessionId: createSessionId(),
    });
  }
}
