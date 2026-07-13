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

export interface ImageInput {
  mediaType: string;
  dataBase64: string;
}

export async function generateText(opts: {
  system: string;
  user: string;
  maxTokens?: number;
  /** Images attached to the request, sent to Claude as vision blocks. */
  images?: ImageInput[];
}): Promise<LlmResult> {
  const images = opts.images ?? [];
  const content =
    images.length === 0
      ? opts.user
      : [
          ...images.map((img) => ({
            type: "image" as const,
            source: {
              type: "base64" as const,
              media_type: img.mediaType as
                | "image/jpeg"
                | "image/png"
                | "image/gif"
                | "image/webp",
              data: img.dataBase64,
            },
          })),
          { type: "text" as const, text: opts.user },
        ];

  const response = await getClient().messages.create({
    model: config.model,
    max_tokens: opts.maxTokens ?? 16000,
    system: opts.system,
    messages: [{ role: "user", content }],
  });
  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  const tokens = response.usage.input_tokens + response.usage.output_tokens;
  return { text, tokens };
}

/**
 * Asks the model for a short, plain-language reason a request couldn't be
 * built, so the user sees an LLM-authored explanation rather than a stack
 * trace. Best-effort: falls back to the raw error text if the call fails.
 */
export async function explainFailure(
  requestText: string,
  technicalError: string,
): Promise<string> {
  try {
    const { text } = await generateText({
      maxTokens: 400,
      system:
        "You are the assistant behind a generative dashboard. A user's feature request could not be built. In 2-4 sentences, plainly explain the exact reason for a non-technical user, then suggest a concrete alternative they could ask for instead. Do not apologize excessively, do not include code, JSON, or stack traces.",
      user: `User request: ${requestText}\n\nInternal reason it failed: ${technicalError}`,
    });
    return text.trim() || technicalError;
  } catch {
    return technicalError;
  }
}
