import type {
  ResponsePlan,
  ResponseRouter,
  RouteRequest,
} from "../../../packages/voice-session/src/index.js";

/**
 * VOICE-004 sends every completed manual turn through the configured text
 * reasoner. Content stays inside the adapter request and is never logged here.
 */
export class ReasoningRouter implements ResponseRouter {
  public async route(
    _request: RouteRequest,
    options: { readonly signal: AbortSignal },
  ): Promise<ResponsePlan> {
    if (options.signal.aborted) {
      throw new Error("Routing was cancelled");
    }
    return { kind: "reason" };
  }
}
