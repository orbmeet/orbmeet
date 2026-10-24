import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createModels, type Api, type Model } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import type { AssistantModelConfig } from "../http/config.ts";

/** Per model call. A drawing turn is mostly tool-call JSON, so this is generous. */
const MAX_OUTPUT_TOKENS = 8_192;

/** The one model every room's assistant talks to. */
export interface AssistantModel {
  model: Model<Api>;
  stream: StreamFn;
}

export function createAssistantModel(config: AssistantModelConfig): AssistantModel {
  const models = createModels();
  models.setProvider(config.provider === "google" ? googleProvider() : anthropicProvider());
  const model = models.getModel(config.provider, config.modelId);
  if (!model) {
    throw new Error(`ASSISTANT_MODEL names an unknown model: ${config.provider}/${config.modelId}`);
  }
  return {
    model,
    stream: (streamModel, context, options) =>
      models.streamSimple(streamModel, context, {
        ...options,
        apiKey: config.apiKey,
        maxTokens: MAX_OUTPUT_TOKENS,
      }),
  };
}
