// @anthropic-ai/sdk: the ONLY process that talks to Claude. The key lives in
// server .env and is never reachable from the client or sandboxed code.
import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config";

let client: Anthropic | null = null;

export function llmAvailable(): boolean {
  return Boolean(config.anthropicApiKey || process.env.ANTHROPIC_AUTH_TOKEN);
}

function getClient(): Anthropic {
  if (!client) client = new Anthropic();
  return client;
}

export interface LlmResult {
  text: string;
  tokens: number;
}

export async function generateText(opts: {
  system: string;
  user: string;
  maxTokens?: number;
}): Promise<LlmResult> {
  const response = await getClient().messages.create({
    model: config.model,
    max_tokens: opts.maxTokens ?? 16000,
    system: opts.system,
    messages: [{ role: "user", content: opts.user }],
  });
  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  const tokens = response.usage.input_tokens + response.usage.output_tokens;
  return { text, tokens };
}
