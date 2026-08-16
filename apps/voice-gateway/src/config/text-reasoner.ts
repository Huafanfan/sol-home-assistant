import {
  loadTextReasonerConfig,
  OpenAiCompatibleTextReasoner,
  type TextReasonerEnvironment,
} from "../../../../packages/text-reasoner/src/index.js";

/**
 * The Gateway owns environment-to-provider composition. Satellites only ever
 * receive the ReasonerAdapter contract, never this configuration or a secret.
 */
export function createTextReasonerFromEnvironment(
  environment: TextReasonerEnvironment = process.env,
): OpenAiCompatibleTextReasoner {
  return new OpenAiCompatibleTextReasoner(loadTextReasonerConfig(environment));
}
