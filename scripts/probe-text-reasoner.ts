import {
  loadTextReasonerConfig,
  OpenAiCompatibleTextReasoner,
  TextReasonerConfigurationError,
  TextReasonerProviderError,
} from "../packages/text-reasoner/src/index.js";

async function main(): Promise<void> {
  const config = loadTextReasonerConfig();
  const reasoner = new OpenAiCompatibleTextReasoner(config);
  const models = await reasoner.listModels({ signal: new AbortController().signal });

  const nonStreamingStartedAt = Date.now();
  const completion = await reasoner.complete(
    {
      finalTranscript:
        "请用一句简体中文解释：创建提醒前为什么必须确认日期、时间和时区？",
    },
    { signal: new AbortController().signal },
  );

  const streamController = new AbortController();
  const streamStartedAt = Date.now();
  const iterator = reasoner
    .stream(
      {
        finalTranscript: "请用一句简体中文说明：我可以如何帮助你？",
      },
      { signal: streamController.signal },
    )
    [Symbol.asyncIterator]();
  const first = await iterator.next();
  const firstSpeakableSegmentMs = Date.now() - streamStartedAt;

  let cancellation: "observed" | "stream_completed_before_abort" | "not_observed";
  if (first.done) {
    cancellation = "stream_completed_before_abort";
  } else {
    streamController.abort();
    try {
      await iterator.next();
      cancellation = "not_observed";
    } catch {
      cancellation = "observed";
    }
  }
  await iterator.return?.();

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        configuration: config.toJSON(),
        availableModelIds: models,
        selectedModelListed: models.includes(config.model),
        nonStreaming: {
          elapsedMs: Date.now() - nonStreamingStartedAt,
          responseCharacterCount: completion.text.length,
        },
        streaming: {
          firstSpeakableSegmentMs: first.done ? null : firstSpeakableSegmentMs,
          firstSegmentCharacterCount: first.done ? 0 : first.value.length,
          localCancellation: cancellation,
        },
      },
      null,
      2,
    )}\n`,
  );
}

void main().catch((error: unknown) => {
  const failure =
    error instanceof TextReasonerConfigurationError
      ? { category: "configuration_invalid", code: error.code }
      : error instanceof TextReasonerProviderError
        ? { category: "provider_failed", code: error.code, status: error.status }
        : { category: "unexpected_failure" };
  process.stderr.write(`${JSON.stringify({ ok: false, failure })}\n`);
  process.exitCode = 1;
});
