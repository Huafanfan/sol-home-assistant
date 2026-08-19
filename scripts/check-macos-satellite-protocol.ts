import { resolve } from "node:path";

import {
  encodeSatelliteFrame,
  SatelliteFrameDecoder,
  SatelliteMessageKind,
} from "../apps/voice-gateway/src/satellite/protocol.js";
import { ChildProcessSatelliteTransport } from "../apps/voice-gateway/src/satellite/process-transport.js";

export async function checkMacosSatelliteProtocol(
  executablePath = resolve(
    process.cwd(),
    "apps/voice-satellite-macos/.build/debug/sol-voice-satellite",
  ),
): Promise<{ readonly receivedFrames: number; readonly exitCode: number }> {
  const transport = new ChildProcessSatelliteTransport({ executablePath });
  const decoder = new SatelliteFrameDecoder();
  let receivedFrames = 0;
  let helloSeen = false;
  let shutdownSeen = false;

  const check = (async () => {
    for await (const chunk of transport.output) {
      for (const frame of decoder.push(chunk)) {
        receivedFrames += 1;
        if (frame.kind === SatelliteMessageKind.hello && !helloSeen) {
          helloSeen = true;
          await transport.write(
            encodeSatelliteFrame({
              kind: SatelliteMessageKind.shutdown,
              payload: new Uint8Array(),
            }),
          );
        } else if (frame.kind === SatelliteMessageKind.shutdownComplete) {
          shutdownSeen = true;
          transport.closeInput();
        } else {
          throw new Error("Unexpected Satellite protocol frame");
        }
      }
    }
    decoder.finish();
    const exit = await transport.exit;
    if (!helloSeen || !shutdownSeen || exit.code !== 0 || exit.failedToStart) {
      throw new Error("Satellite protocol smoke check failed");
    }
    return { receivedFrames, exitCode: exit.code };
  })();

  const timeout = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => {
      transport.terminate();
      reject(new Error("Satellite protocol smoke check timed out"));
    }, 5_000);
    timer.unref();
  });
  return Promise.race([check, timeout]);
}

if (process.argv[1]?.endsWith("check-macos-satellite-protocol.js") === true) {
  try {
    const report = await checkMacosSatelliteProtocol();
    console.log(JSON.stringify({ status: "ok", ...report }));
  } catch {
    console.error(JSON.stringify({ status: "failed" }));
    process.exitCode = 1;
  }
}
