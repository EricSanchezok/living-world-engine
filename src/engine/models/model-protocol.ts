import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createXai } from "@ai-sdk/xai";
import type { LanguageModel } from "ai";
import type { ModelExecutionAudit } from "../contracts/model";
import type { ModelProtocol } from "./model-catalog";
import type { ResolvedModelBinding } from "./model-registry";

export interface ProtocolModelOptions {
  apiKey: string;
  fetch: typeof fetch;
  authentication: import("./model-dialect").VendorDialectRequestPlan["authentication"];
  structuredOutputMode: ModelExecutionAudit["structuredOutputMode"];
}

export interface ProtocolDriver {
  readonly id: ModelProtocol;
  createModel(binding: ResolvedModelBinding, options: ProtocolModelOptions): LanguageModel;
}

const openAIChatDriver: ProtocolDriver = {
  id: "openai-chat",
  createModel(binding, options) {
    if (options.authentication === "x-api-key") {
      throw new Error("openai-chat protocol does not support x-api-key authentication");
    }
    return createOpenAICompatible({
      name: binding.account.dialect,
      baseURL: binding.account.base_url,
      apiKey: options.authentication === "bearer" ? options.apiKey : undefined,
      headers: options.authentication === "api-key" ? { "api-key": options.apiKey } : undefined,
      fetch: options.fetch,
      supportsStructuredOutputs: options.structuredOutputMode === "json-schema-strict",
      ...(binding.profile.response_transport ? { includeUsage: true } : {}),
    }).chatModel(binding.modelId);
  },
};

const openAIResponsesDriver: ProtocolDriver = {
  id: "openai-responses",
  createModel(binding, options) {
    if (options.authentication !== "bearer") {
      throw new Error("openai-responses protocol requires bearer authentication");
    }
    if (binding.account.dialect === "openai" || binding.account.dialect === "deepseek") {
      return createOpenAI({
        baseURL: binding.account.base_url,
        apiKey: options.apiKey,
        fetch: options.fetch,
      }).responses(binding.modelId);
    }
    if (binding.account.dialect === "xai") {
      return createXai({
        baseURL: binding.account.base_url,
        apiKey: options.apiKey,
        fetch: options.fetch,
      }).responses(binding.modelId);
    }
    throw new Error(
      `openai-responses protocol has no native client for dialect ${binding.account.dialect}`,
    );
  },
};

const anthropicMessagesDriver: ProtocolDriver = {
  id: "anthropic-messages",
  createModel(binding, options) {
    if (options.authentication === "api-key") {
      throw new Error("anthropic-messages protocol does not support api-key authentication");
    }
    return createAnthropic({
      name: binding.account.dialect,
      baseURL: binding.account.base_url,
      ...(options.authentication === "bearer"
        ? { authToken: options.apiKey }
        : { apiKey: options.apiKey }),
      fetch: options.fetch,
    }).messages(binding.modelId);
  },
};

const drivers = new Map<ModelProtocol, ProtocolDriver>([
  [openAIChatDriver.id, openAIChatDriver],
  [openAIResponsesDriver.id, openAIResponsesDriver],
  [anthropicMessagesDriver.id, anthropicMessagesDriver],
]);

export function protocolDriver(protocol: ModelProtocol): ProtocolDriver {
  const driver = drivers.get(protocol);
  if (!driver) throw new Error(`unknown model protocol driver ${protocol}`);
  return driver;
}
