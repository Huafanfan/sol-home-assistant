import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  bootstrapTextReasonerEnv,
  BootstrapTextReasonerEnvError,
} from "../scripts/bootstrap-text-reasoner-env.js";

test("creates a new private .env from IVAN source variables and never overwrites it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sol-text-reasoner-"));
  const destination = join(directory, ".env");

  try {
    await bootstrapTextReasonerEnv({
      sourceEnvironment: {
        IVAN_ONLINE_API_URL: "https://example.test/v1/chat/completions",
        IVAN_ONLINE_API_KEY: "test-source-api-key",
      },
      destination,
      model: "test-model",
    });

    const contents = await readFile(destination, "utf8");
    const mode = (await stat(destination)).mode & 0o777;
    assert.equal(mode, 0o600);
    assert.equal(contents.includes("IVAN_ONLINE_"), false);
    assert.equal(contents.includes("TEXT_REASONER_PROVIDER=\"openai_compatible\""), true);
    assert.equal(contents.includes("TEXT_REASONER_MODEL=\"test-model\""), true);
    assert.equal(contents.includes("TEXT_REASONER_API_KEY=\"test-source-api-key\""), true);

    await assert.rejects(
      bootstrapTextReasonerEnv({
        sourceEnvironment: {
          IVAN_ONLINE_API_URL: "https://example.test/v1/chat/completions",
          IVAN_ONLINE_API_KEY: "different-test-source-api-key",
        },
        destination,
        model: "different-model",
      }),
      (error: unknown) =>
        error instanceof BootstrapTextReasonerEnvError &&
        error.code === "env_file_exists",
    );
    assert.equal(await readFile(destination, "utf8"), contents);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("refuses missing or invalid source configuration before creating a file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sol-text-reasoner-"));
  const destination = join(directory, ".env");

  try {
    await assert.rejects(
      bootstrapTextReasonerEnv({
        sourceEnvironment: { IVAN_ONLINE_API_KEY: "test-source-api-key" },
        destination,
        model: "test-model",
      }),
      (error: unknown) =>
        error instanceof BootstrapTextReasonerEnvError &&
        error.code === "source_configuration_missing",
    );
    await assert.rejects(stat(destination), { code: "ENOENT" });

    await assert.rejects(
      bootstrapTextReasonerEnv({
        sourceEnvironment: {
          IVAN_ONLINE_API_URL: "http://provider.example.test/v1",
          IVAN_ONLINE_API_KEY: "test-source-api-key",
        },
        destination,
        model: "test-model",
      }),
      (error: unknown) =>
        error instanceof BootstrapTextReasonerEnvError &&
        error.code === "source_configuration_invalid",
    );
    await assert.rejects(stat(destination), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
