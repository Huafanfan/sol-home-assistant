import type {
  ReasonerAdapter,
  ReasonerRequest,
} from "../../voice-session/src/contracts.js";
import { TextReasonerConfig } from "./config.js";
import {
  providerErrorForStatus,
  TextReasonerProviderError,
} from "./errors.js";

export interface TextReasonerRequestOptions {
  readonly signal: AbortSignal;
}

export interface TextReasonerCompletion {
  readonly text: string;
}

type JsonRecord = Record<string, unknown>;

const systemPrompt =
  "你是 Sol 家庭 AI 助手的文本推理层。用简体中文给出准确、简洁、适合朗读的回答。不要假称已执行现实世界操作；未提供的信息应明确说明。";

/**
 * OpenAI-compatible text-only boundary. This class never logs, persists, or
 * accepts raw audio, partial transcripts, full conversations, memory records,
 * provider credentials, or tool definitions.
 */
export class OpenAiCompatibleTextReasoner implements ReasonerAdapter {
  public constructor(private readonly config: TextReasonerConfig) {}

  public async listModels(
    options: TextReasonerRequestOptions,
  ): Promise<readonly string[]> {
    const request = await this.#open(
      this.config.modelsUrl(),
      {
        method: "GET",
        headers: {
          Authorization: this.config.authorizationHeader(),
          Accept: "application/json",
        },
      },
      options.signal,
    );

    try {
      const payload = await this.#readJson(request.response, request.scope, options.signal);
      if (!isRecord(payload) || !Array.isArray(payload.data)) {
        throw new TextReasonerProviderError("protocol_unsupported");
      }

      const models = payload.data
        .map((entry) => (isRecord(entry) ? entry.id : undefined))
        .filter((id): id is string => typeof id === "string")
        .sort();
      return [...new Set(models)];
    } finally {
      request.scope.dispose();
    }
  }

  public async complete(
    request: ReasonerRequest,
    options: TextReasonerRequestOptions,
  ): Promise<TextReasonerCompletion> {
    const opened = await this.#open(
      this.config.chatCompletionsUrl(),
      this.#chatRequest(request, false),
      options.signal,
    );

    try {
      const payload = await this.#readJson(opened.response, opened.scope, options.signal);
      const text = nonStreamingContent(payload);
      return { text };
    } finally {
      opened.scope.dispose();
    }
  }

  public async *stream(
    request: ReasonerRequest,
    options: TextReasonerRequestOptions,
  ): AsyncIterable<string> {
    let opened: OpenedRequest | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let completed = false;

    try {
      opened = await this.#open(
        this.config.chatCompletionsUrl(),
        this.#chatRequest(request, true),
        options.signal,
      );
      reader = opened.response.body?.getReader();
      if (reader === undefined) {
        throw new TextReasonerProviderError("protocol_unsupported");
      }

      const decoder = new TextDecoder();
      let sseBuffer = "";
      let speechBuffer = "";

      while (!completed) {
        const next = await this.#readStreamChunk(reader, opened.scope, options.signal);
        if (next.done) {
          break;
        }

        sseBuffer += decoder.decode(next.value, { stream: true });
        const parsed = consumeSseLines(sseBuffer);
        sseBuffer = parsed.remainder;

        for (const data of parsed.dataLines) {
          if (data === "[DONE]") {
            completed = true;
            break;
          }

          const content = streamingContent(data);
          if (content === undefined) {
            continue;
          }

          speechBuffer += content;
          const segmented = takeSpeakableSegments(speechBuffer);
          speechBuffer = segmented.remainder;
          for (const segment of segmented.segments) {
            assertNotAborted(options.signal);
            yield segment;
          }
        }
      }

      sseBuffer += decoder.decode();
      if (!completed && sseBuffer.trim().length > 0) {
        const trailing = consumeSseLines(`${sseBuffer}\n`);
        for (const data of trailing.dataLines) {
          if (data === "[DONE]") {
            completed = true;
            break;
          }

          const content = streamingContent(data);
          if (content !== undefined) {
            speechBuffer += content;
          }
        }
      }

      if (!completed) {
        throw new TextReasonerProviderError("protocol_unsupported");
      }

      const finalSegment = speechBuffer.trim();
      if (finalSegment.length > 0) {
        assertNotAborted(options.signal);
        yield finalSegment;
      }
    } catch (error: unknown) {
      throw safeStreamError(error, opened?.scope, options.signal);
    } finally {
      if (!completed) {
        opened?.scope.abort();
      }
      try {
        await reader?.cancel();
      } catch {
        // Cancellation is best effort and must not expose transport details.
      }
      reader?.releaseLock();
      opened?.scope.dispose();
    }
  }

  #chatRequest(request: ReasonerRequest, stream: boolean): RequestInit {
    return {
      method: "POST",
      headers: {
        Authorization: this.config.authorizationHeader(),
        "Content-Type": "application/json",
        Accept: stream ? "text/event-stream" : "application/json",
      },
      body: JSON.stringify({
        model: this.config.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: requestContent(request) },
        ],
        temperature: 0.2,
        max_tokens: this.config.maxTokens,
        stream,
      }),
      redirect: "error",
    };
  }

  async #open(
    endpoint: URL,
    init: RequestInit,
    parentSignal: AbortSignal,
  ): Promise<OpenedRequest> {
    const scope = createRequestScope(parentSignal, this.config.timeoutMs);
    try {
      const response = await fetch(endpoint, {
        ...init,
        redirect: "error",
        signal: scope.signal,
      });
      if (!response.ok) {
        try {
          await response.body?.cancel();
        } catch {
          // A failed response body is never read or logged.
        }
        throw providerErrorForStatus(response.status);
      }

      return { response, scope };
    } catch (error: unknown) {
      scope.dispose();
      throw safeRequestError(error, scope, parentSignal);
    }
  }

  async #readJson(
    response: Response,
    scope: RequestScope,
    parentSignal: AbortSignal,
  ): Promise<unknown> {
    try {
      return await response.json();
    } catch (error: unknown) {
      if (parentSignal.aborted) {
        throw error;
      }
      if (scope.didTimeOut()) {
        throw new TextReasonerProviderError("timed_out");
      }
      throw new TextReasonerProviderError("protocol_unsupported");
    }
  }

  async #readStreamChunk(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    scope: RequestScope,
    parentSignal: AbortSignal,
  ): Promise<ReadableStreamReadResult<Uint8Array>> {
    try {
      return await reader.read();
    } catch (error: unknown) {
      throw safeRequestError(error, scope, parentSignal);
    }
  }
}

interface OpenedRequest {
  readonly response: Response;
  readonly scope: RequestScope;
}

interface RequestScope {
  readonly signal: AbortSignal;
  readonly didTimeOut: () => boolean;
  readonly abort: () => void;
  readonly dispose: () => void;
}

function createRequestScope(parentSignal: AbortSignal, timeoutMs: number): RequestScope {
  const controller = new AbortController();
  let timedOut = false;
  const forwardParentAbort = () => controller.abort();
  if (parentSignal.aborted) {
    forwardParentAbort();
  } else {
    parentSignal.addEventListener("abort", forwardParentAbort, { once: true });
  }

  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  return {
    signal: controller.signal,
    didTimeOut: () => timedOut,
    abort: () => controller.abort(),
    dispose: () => {
      clearTimeout(timeout);
      parentSignal.removeEventListener("abort", forwardParentAbort);
    },
  };
}

function safeRequestError(
  error: unknown,
  scope: RequestScope,
  parentSignal: AbortSignal,
): unknown {
  if (error instanceof TextReasonerProviderError || parentSignal.aborted) {
    return error;
  }

  if (scope.didTimeOut()) {
    return new TextReasonerProviderError("timed_out");
  }

  return new TextReasonerProviderError("network_failed");
}

function safeStreamError(
  error: unknown,
  scope: RequestScope | undefined,
  parentSignal: AbortSignal,
): unknown {
  if (scope === undefined) {
    return error;
  }

  return safeRequestError(error, scope, parentSignal);
}

function requestContent(request: ReasonerRequest): string {
  const finalTranscript = request.finalTranscript.trim();
  if (finalTranscript.length === 0) {
    throw new TextReasonerProviderError("request_rejected");
  }

  const summary = request.sessionSummary?.trim();
  if (summary === undefined || summary.length === 0) {
    return `用户最终转写：${finalTranscript}`;
  }

  return `用户最终转写：${finalTranscript}\n\n已获批准的最小化会话摘要：${summary}`;
}

function nonStreamingContent(payload: unknown): string {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) {
    throw new TextReasonerProviderError("protocol_unsupported");
  }

  const firstChoice = payload.choices[0];
  if (!isRecord(firstChoice) || !isRecord(firstChoice.message)) {
    throw new TextReasonerProviderError("protocol_unsupported");
  }

  const content = firstChoice.message.content;
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new TextReasonerProviderError("protocol_unsupported");
  }

  return content;
}

function consumeSseLines(buffer: string): {
  readonly dataLines: readonly string[];
  readonly remainder: string;
} {
  const lines = buffer.split("\n");
  const remainder = lines.pop() ?? "";
  const dataLines: string[] = [];
  for (const rawLine of lines) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
  }

  return { dataLines, remainder };
}

function streamingContent(data: string): string | undefined {
  let payload: unknown;
  try {
    payload = JSON.parse(data);
  } catch {
    throw new TextReasonerProviderError("protocol_unsupported");
  }

  if (!isRecord(payload) || !Array.isArray(payload.choices)) {
    throw new TextReasonerProviderError("protocol_unsupported");
  }

  const firstChoice = payload.choices[0];
  if (!isRecord(firstChoice)) {
    return undefined;
  }

  const delta = firstChoice.delta;
  if (!isRecord(delta)) {
    return undefined;
  }

  if ("tool_calls" in delta) {
    throw new TextReasonerProviderError("protocol_unsupported");
  }

  const content = delta.content;
  if (content === undefined || content === null) {
    return undefined;
  }
  if (typeof content !== "string") {
    throw new TextReasonerProviderError("protocol_unsupported");
  }

  return content;
}

function takeSpeakableSegments(text: string): {
  readonly segments: readonly string[];
  readonly remainder: string;
} {
  const segments: string[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (!"。！？!?；;\n".includes(text[index] ?? "")) {
      continue;
    }

    const segment = text.slice(start, index + 1).trim();
    if (segment.length > 0) {
      segments.push(segment);
    }
    start = index + 1;
  }

  return { segments, remainder: text.slice(start) };
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException("The text reasoner request was cancelled", "AbortError");
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
