import OpenAI from "openai";
import { config } from "../config.js";

export type LLMCompletionParams = {
  systemPrompt: string;
  userPrompt: string;
  maxTokens?: number;
  temperature?: number;
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
    async complete({ systemPrompt, userPrompt, maxTokens = 2048, temperature = 0.5 }) {
      const result = await client.chat.completions.create({
        model: config.azureOpenAIDeployment,
        max_tokens: maxTokens,
        temperature,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      });
      return result.choices[0]?.message?.content ?? "{}";
    },
  };
}

export const agentLLMClient: LLMClient = createAzureLLMClient() ?? noopClient;
