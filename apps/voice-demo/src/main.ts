import {
  InMemoryMetrics,
  RecordingPlayback,
  ScriptedAsr,
  StaticReasoner,
  StaticRouter,
  StaticTts,
} from "../../../packages/voice-session/src/index.js";
import { VoiceGateway } from "../../voice-gateway/src/index.js";

const metrics = new InMemoryMetrics();
const gateway = new VoiceGateway({
  asr: new ScriptedAsr("diagnostic transcript"),
  router: new StaticRouter({ kind: "reason" }),
  reasoner: new StaticReasoner(["diagnostic response"]),
  tts: new StaticTts(),
  playback: new RecordingPlayback(),
  metrics,
});

const session = gateway.createSession();
const completion = session.begin();
session.pushAudio(new Uint8Array([1, 2, 3, 4]));
session.endAudio();

const outcome = await completion;
console.log(
  JSON.stringify(
    {
      outcome: outcome.kind,
      finalState: session.state,
      metrics: metrics.summary(),
    },
    null,
    2,
  ),
);
