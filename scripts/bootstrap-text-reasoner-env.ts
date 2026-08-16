import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadTextReasonerConfig,
  TextReasonerConfigurationError,
  type TextReasonerEnvironment,
} from "../packages/text-reasoner/src/index.js";

export type BootstrapTextReasonerEnvErrorCode =
  | "source_configuration_missing"
  | "source_configuration_invalid"
  | "model_required"
  | "env_file_exists"
  | "env_file_write_failed";

/** Safe, non-secret error categories for the local .env bootstrap only. */
export class BootstrapTextReasonerEnvError extends Error {
  public constructor(public readonly code: BootstrapTextReasonerEnvErrorCode) {
    super(`Text reasoner .env bootstrap failed: ${code}`);
    this.name = "BootstrapTextReasonerEnvError";
  }
}

export async function bootstrapTextReasonerEnv(options: {
  readonly sourceEnvironment: TextReasonerEnvironment;
  readonly destination: string;
  readonly model: string;
}): Promise<void> {
  const baseUrl = sourceValue(options.sourceEnvironment, "IVAN_ONLINE_API_URL");
  const apiKey = sourceValue(options.sourceEnvironment, "IVAN_ONLINE_API_KEY");
  const model = options.model.trim();
  if (model.length === 0) {
    throw new BootstrapTextReasonerEnvError("model_required");
  }

  const generatedEnvironment = {
    TEXT_REASONER_PROVIDER: "openai_compatible",
    TEXT_REASONER_BASE_URL: baseUrl,
    TEXT_REASONER_API_KEY: apiKey,
    TEXT_REASONER_MODEL: model,
    TEXT_REASONER_TIMEOUT_MS: "30000",
    TEXT_REASONER_MAX_TOKENS: "256",
    TEXT_REASONER_ALLOW_AUDIO: "false",
  } satisfies TextReasonerEnvironment;

  try {
    loadTextReasonerConfig(generatedEnvironment);
  } catch (error: unknown) {
    if (error instanceof TextReasonerConfigurationError) {
      throw new BootstrapTextReasonerEnvError("source_configuration_invalid");
    }
    throw error;
  }

  let file;
  try {
    file = await open(resolve(options.destination), "wx", 0o600);
  } catch (error: unknown) {
    if (hasNodeErrorCode(error, "EEXIST")) {
      throw new BootstrapTextReasonerEnvError("env_file_exists");
    }
    throw new BootstrapTextReasonerEnvError("env_file_write_failed");
  }

  try {
    await file.writeFile(serializeEnvironment(generatedEnvironment), "utf8");
    await file.chmod(0o600);
  } catch {
    throw new BootstrapTextReasonerEnvError("env_file_write_failed");
  } finally {
    await file.close();
  }
}

function sourceValue(
  environment: TextReasonerEnvironment,
  name: "IVAN_ONLINE_API_URL" | "IVAN_ONLINE_API_KEY",
): string {
  const value = environment[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new BootstrapTextReasonerEnvError("source_configuration_missing");
  }

  return value;
}

function serializeEnvironment(environment: TextReasonerEnvironment): string {
  const requiredNames = [
    "TEXT_REASONER_PROVIDER",
    "TEXT_REASONER_BASE_URL",
    "TEXT_REASONER_API_KEY",
    "TEXT_REASONER_MODEL",
    "TEXT_REASONER_TIMEOUT_MS",
    "TEXT_REASONER_MAX_TOKENS",
    "TEXT_REASONER_ALLOW_AUDIO",
  ] as const;

  const lines = requiredNames.map((name) => {
    const value = environment[name];
    if (typeof value !== "string") {
      throw new BootstrapTextReasonerEnvError("env_file_write_failed");
    }
    return `${name}=${JSON.stringify(value)}`;
  });

  return [
    "# Generated locally by scripts/bootstrap-text-reasoner-env.ts.",
    "# This file is private, ignored by Git, and contains provider credentials.",
    ...lines,
    "",
  ].join("\n");
}

function hasNodeErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function modelFromArguments(argumentsList: readonly string[]): string {
  const argument = argumentsList.find((value) => value.startsWith("--model="));
  if (argument === undefined) {
    throw new BootstrapTextReasonerEnvError("model_required");
  }

  return argument.slice("--model=".length);
}

async function main(): Promise<void> {
  await bootstrapTextReasonerEnv({
    sourceEnvironment: process.env,
    destination: resolve(process.cwd(), ".env"),
    model: modelFromArguments(process.argv.slice(2)),
  });
  process.stdout.write("Created local text reasoner .env.\n");
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  resolve(invokedPath) === fileURLToPath(import.meta.url)
) {
  void main().catch((error: unknown) => {
    const code =
      error instanceof BootstrapTextReasonerEnvError
        ? error.code
        : "env_file_write_failed";
    process.stderr.write(`Text reasoner .env bootstrap failed: ${code}\n`);
    process.exitCode = 1;
  });
}
