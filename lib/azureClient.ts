import OpenAI from "openai";
import { config } from "../config.js";

export type LLMCompletionParams = {
  systemPrompt: string;
  userPrompt: string;
  maxTokens?: number;
  temperature?: number;
  /** When provided, the completion is streamed and each token delta is emitted
   * live as it arrives. The full text is still accumulated and returned, so
   * callers that JSON.parse the result are unaffected. */
  onToken?: (delta: string) => void;
};

export type LLMClient = {
  provider: "azure" | "none";
  complete(params: LLMCompletionParams): Promise<string>;
};

let cachedClient: OpenAI | null = null;

export function getAzureClient(): OpenAI | null {
  if (cachedClient) return cachedClient;
  if (!config.azureOpenAIEndpoint || !config.azureOpenAIKey) return null;
  // Foundry serverless models use the standard OpenAI API shape with a custom
  // baseURL and Bearer auth — not the AzureOpenAI deployment-URL pattern.
  cachedClient = new OpenAI({
    apiKey: config.azureOpenAIKey,
    baseURL: config.azureOpenAIEndpoint,
  });
  return cachedClient;
}

export function getAzureDeployment(): string {
  return config.azureOpenAIDeployment;
}

export function isAzureConfigured(): boolean {
  return !!(config.azureOpenAIEndpoint && config.azureOpenAIKey);
}

const noopClient: LLMClient = {
  provider: "none",
  async complete() {
    throw new Error(
      "Azure OpenAI not configured. Set AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY."
    );
  },
};

function createAzureLLMClient(): LLMClient | null {
  const client = getAzureClient();
  if (!client) return null;
  return {
    provider: "azure",
    async complete({ systemPrompt, userPrompt, maxTokens = 2048, temperature = 0.5, onToken }) {
      const messages = [
        { role: "system" as const, content: systemPrompt },
        { role: "user" as const, content: userPrompt },
      ];

      // Streaming path: surface live token deltas while accumulating the full
      // text (so JSON.parse on the result still works). If the stream yields
      // nothing (an occasional Foundry hiccup), fall through to a normal
      // (non-streamed) completion so callers never get empty output.
      if (onToken) {
        const stream = await client.chat.completions.create({
          model: config.azureOpenAIDeployment,
          max_tokens: maxTokens,
          temperature,
          response_format: { type: "json_object" },
          stream: true,
          messages,
        });
        let full = "";
        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta?.content ?? "";
          if (delta) {
            full += delta;
            try {
              onToken(delta);
            } catch {
              /* never let a UI emitter break inference */
            }
          }
        }
        if (full.trim()) return full;
        // else: empty stream — fall through to the non-streaming call below.
      }

      const result = await client.chat.completions.create({
        model: config.azureOpenAIDeployment,
        max_tokens: maxTokens,
        temperature,
        response_format: { type: "json_object" },
        messages,
      });
      return result.choices[0]?.message?.content ?? "{}";
    },
  };
}

export const agentLLMClient: LLMClient = createAzureLLMClient() ?? noopClient;
