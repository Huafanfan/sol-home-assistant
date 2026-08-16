import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import test from "node:test";

import {
  loadTextReasonerConfig,
  OpenAiCompatibleTextReasoner,
  TextReasonerConfigurationError,
  TextReasonerProviderError,
  type TextReasonerEnvironment,
} from "../packages/text-reasoner/src/index.js";
import type { ReasonerRequest } from "../packages/voice-session/src/index.js";
import {
  RecordingPlayback,
  ScriptedAsr,
  StaticRouter,
  StaticTts,
  VoiceSession,
} from "../packages/voice-session/src/index.js";

test("normalizes a root or Chat Completions URL without serializing endpoint or credential", () => {
  const fromRoot = loadTextReasonerConfig(
    environment({ TEXT_REASONER_BASE_URL: "https://example.test/v1/?discarded=yes#fragment" }),
  );
  assert.equal(fromRoot.chatCompletionsUrl().pathname, "/v1/chat/completions");
  assert.equal(fromRoot.modelsUrl().pathname, "/v1/models");
  assert.equal(fromRoot.chatCompletionsUrl().search, "");

  const fromCompletion = loadTextReasonerConfig(
    environment({
      TEXT_REASONER_BASE_URL:
        "https://example.test/v1/chat/completions?discarded=yes#fragment",
    }),
  );
  assert.equal(fromCompletion.chatCompletionsUrl().pathname, "/v1/chat/completions");
  assert.equal(fromCompletion.modelsUrl().pathname, "/v1/models");

  const serialized = JSON.stringify(fromCompletion);
  assert.equal(serialized.includes("example.test"), false);
  assert.equal(serialized.includes("test-api-key"), false);
  assert.deepEqual(JSON.parse(serialized), {
    provider: "openai_compatible",
    model: "test-model",
    timeoutMs: 30_000,
    maxTokens: 256,
  });
});

test("rejects unsafe or incomplete configuration without rendering credential data", () => {
  assert.throws(
    () => loadTextReasonerConfig(environment({ TEXT_REASONER_BASE_URL: "" })),
    (error: unknown) =>
      error instanceof TextReasonerConfigurationError &&
      error.code === "base_url_missing",
  );
  assert.throws(
    () =>
      loadTextReasonerConfig(
        environment({ TEXT_REASONER_PROVIDER: "unsupported_provider" }),
      ),
    (error: unknown) =>
      error instanceof TextReasonerConfigurationError &&
      error.code === "provider_invalid",
  );
  assert.throws(
    () =>
      loadTextReasonerConfig(
        environment({ TEXT_REASONER_BASE_URL: "http://provider.example.test/v1" }),
      ),
    (error: unknown) =>
      error instanceof TextReasonerConfigurationError &&
      error.code === "base_url_invalid" &&
      !error.message.includes("test-api-key"),
  );
  assert.throws(
    () => loadTextReasonerConfig(environment({ TEXT_REASONER_MODEL: "" })),
    (error: unknown) =>
      error instanceof TextReasonerConfigurationError &&
      error.code === "model_missing",
  );
  assert.throws(
    () =>
      loadTextReasonerConfig(
        environment({ TEXT_REASONER_API_KEY: "test-api-key\nnot-allowed" }),
      ),
    (error: unknown) =>
      error instanceof TextReasonerConfigurationError &&
      error.code === "api_key_invalid" &&
      !error.message.includes("test-api-key"),
  );
  assert.throws(
    () =>
      loadTextReasonerConfig(
        environment({ TEXT_REASONER_TIMEOUT_MS: "0" }),
      ),
    (error: unknown) =>
      error instanceof TextReasonerConfigurationError &&
      error.code === "timeout_invalid",
  );
});

test("lists models, completes text, streams sentence chunks, and sends only allowed fields", async () => {
  const requestBodies: unknown[] = [];
  const headers: string[] = [];
  const server = await startServer(async (request, response) => {
    if (request.url === "/v1/models") {
      writeJson(response, 200, {
        data: [{ id: "gpt-5.6-sol" }, { id: "gpt-5.6-terra" }],
      });
      return;
    }

    if (request.url !== "/v1/chat/completions") {
      writeJson(response, 404, {});
      return;
    }

    headers.push(String(request.headers.authorization));
    const body = await readJsonBody(request);
    requestBodies.push(body);
    if (body.stream === true) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write('data: {"choices":[{"delta":{"content":"第一句。"}}]}\n\n');
      response.write('data: {"choices":[{"delta":{"content":"第二"}}]}\n\n');
      response.end(
        'data: {"choices":[{"delta":{"content":"句。"}}]}\n\ndata: [DONE]\n\n',
      );
      return;
    }

    writeJson(response, 200, {
      choices: [{ message: { content: "普通回答。" } }],
    });
  });

  try {
    const reasoner = new OpenAiCompatibleTextReasoner(
      loadTextReasonerConfig(
        environment({ TEXT_REASONER_BASE_URL: server.baseUrl }),
      ),
    );
    const signal = new AbortController().signal;
    assert.deepEqual(await reasoner.listModels({ signal }), [
      "gpt-5.6-sol",
      "gpt-5.6-terra",
    ]);

    const unsafeRuntimeShape = {
      finalTranscript: "最终转写",
      sessionSummary: "最小摘要",
      audio: "AUDIO_MUST_NOT_BE_SENT",
      partialTranscript: "PARTIAL_MUST_NOT_BE_SENT",
      fullTranscript: "FULL_MUST_NOT_BE_SENT",
      memoryItems: "MEMORY_MUST_NOT_BE_SENT",
    } as ReasonerRequest;
    assert.deepEqual(await reasoner.complete(unsafeRuntimeShape, { signal }), {
      text: "普通回答。",
    });

    const segments: string[] = [];
    for await (const segment of reasoner.stream(unsafeRuntimeShape, { signal })) {
      segments.push(segment);
    }
    assert.deepEqual(segments, ["第一句。", "第二句。"]);

    assert.equal(headers.every((value) => value === "Bearer test-api-key"), true);
    const serializedRequests = JSON.stringify(requestBodies);
    assert.equal(serializedRequests.includes("AUDIO_MUST_NOT_BE_SENT"), false);
    assert.equal(serializedRequests.includes("PARTIAL_MUST_NOT_BE_SENT"), false);
    assert.equal(serializedRequests.includes("FULL_MUST_NOT_BE_SENT"), false);
    assert.equal(serializedRequests.includes("MEMORY_MUST_NOT_BE_SENT"), false);

    const streamingRequest = requestBodies.at(-1);
    assert.ok(isRecord(streamingRequest));
    assert.deepEqual(Object.keys(streamingRequest).sort(), [
      "max_tokens",
      "messages",
      "model",
      "stream",
      "temperature",
    ]);
    assert.equal("tools" in streamingRequest, false);
    assert.equal("audio" in streamingRequest, false);
  } finally {
    await server.close();
  }
});

test("maps 401, 429, and 5xx responses to safe provider categories", async () => {
  let status = 401;
  const server = await startServer((_request, response) => {
    writeJson(response, status, { error: "body is intentionally ignored" });
  });

  try {
    const reasoner = new OpenAiCompatibleTextReasoner(
      loadTextReasonerConfig(
        environment({ TEXT_REASONER_BASE_URL: server.baseUrl }),
      ),
    );
    const cases: readonly [number, TextReasonerProviderError["code"]][] = [
      [401, "authentication_failed"],
      [429, "rate_limited"],
      [503, "provider_unavailable"],
    ];

    for (const [nextStatus, expectedCode] of cases) {
      status = nextStatus;
      await assert.rejects(
        reasoner.complete(
          { finalTranscript: "安全测试" },
          { signal: new AbortController().signal },
        ),
        (error: unknown) =>
          error instanceof TextReasonerProviderError &&
          error.code === expectedCode &&
          error.status === nextStatus &&
          !error.message.includes("body is intentionally ignored"),
      );
    }
  } finally {
    await server.close();
  }
});

test("enforces its own bounded timeout without returning provider body text", async () => {
  const server = await startServer(() => {
    // Keep the request open until the client-side timeout aborts it.
  });

  try {
    const reasoner = new OpenAiCompatibleTextReasoner(
      loadTextReasonerConfig(
        environment({
          TEXT_REASONER_BASE_URL: server.baseUrl,
          TEXT_REASONER_TIMEOUT_MS: "20",
        }),
      ),
    );
    await assert.rejects(
      reasoner.complete(
        { finalTranscript: "超时测试" },
        { signal: new AbortController().signal },
      ),
      (error: unknown) =>
        error instanceof TextReasonerProviderError && error.code === "timed_out",
    );
  } finally {
    await server.close();
  }
});

test("propagates AbortSignal and does not emit text after caller cancellation", async () => {
  let clientClosed = false;
  const server = await startServer((request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write('data: {"choices":[{"delta":{"content":"首句。"}}]}\n\n');
    request.once("close", () => {
      clientClosed = true;
      response.end();
    });
  });

  try {
    const reasoner = new OpenAiCompatibleTextReasoner(
      loadTextReasonerConfig(
        environment({ TEXT_REASONER_BASE_URL: server.baseUrl }),
      ),
    );
    const controller = new AbortController();
    const iterator = reasoner
      .stream(
        { finalTranscript: "取消测试" },
        { signal: controller.signal },
      )
      [Symbol.asyncIterator]();
    assert.deepEqual(await iterator.next(), { value: "首句。", done: false });

    controller.abort();
    await assert.rejects(iterator.next());
    await iterator.return?.();
    await waitFor(() => clientClosed);
  } finally {
    await server.close();
  }
});

test("injects into VOICE-001 and stops later provider text before TTS after interruption", async () => {
  const server = await startServer((request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write('data: {"choices":[{"delta":{"content":"第一句。"}}]}\n\n');
    const laterResponse = setTimeout(() => {
      response.end(
        'data: {"choices":[{"delta":{"content":"第二句。"}}]}\n\ndata: [DONE]\n\n',
      );
    }, 100);
    request.once("close", () => clearTimeout(laterResponse));
  });

  try {
    const tts = new StaticTts();
    const session = new VoiceSession({
      sessionId: "real-text-reasoner-interruption",
      asr: new ScriptedAsr("需要深度推理"),
      router: new StaticRouter({ kind: "reason" }),
      reasoner: new OpenAiCompatibleTextReasoner(
        loadTextReasonerConfig(
          environment({ TEXT_REASONER_BASE_URL: server.baseUrl }),
        ),
      ),
      tts,
      playback: new RecordingPlayback(),
    });

    const completion = session.begin();
    session.pushAudio(new Uint8Array([1]));
    session.endAudio();
    await waitFor(() => session.state === "DEEP_REASONING" && tts.calls === 1);

    assert.deepEqual(await session.interrupt(), {
      kind: "interrupted",
      stage: "reasoner",
    });
    assert.deepEqual(await completion, {
      kind: "interrupted",
      stage: "reasoner",
    });
    assert.equal(tts.calls, 1);
    assert.equal(session.state, "IDLE");
  } finally {
    await server.close();
  }
});

function environment(
  overrides: Partial<TextReasonerEnvironment> = {},
): TextReasonerEnvironment {
  return {
    TEXT_REASONER_PROVIDER: "openai_compatible",
    TEXT_REASONER_BASE_URL: "https://example.test/v1",
    TEXT_REASONER_API_KEY: "test-api-key",
    TEXT_REASONER_MODEL: "test-model",
    ...overrides,
  };
}

async function startServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
): Promise<{ readonly baseUrl: string; readonly close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    void Promise.resolve(handler(request, response)).catch(() => {
      response.destroy();
    });
  });
  await listen(server);
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Test server did not expose a TCP address");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: async () => {
      server.closeAllConnections();
      await close(server);
    },
  };
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolve();
        return;
      }
      reject(error);
    });
  });
}

async function readJsonBody(request: IncomingMessage): Promise<JsonRecord> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const payload: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!isRecord(payload)) {
    throw new Error("Expected JSON request object");
  }
  return payload;
}

function writeJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("Timed out waiting for client cancellation to reach the test server");
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
