// @anthropic-ai/sdk: the ONLY process that talks to Claude. The key lives in
// server .env and is never reachable from the client or sandboxed code.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
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

/**
 * System prompts are split for Anthropic prompt caching: `stable` (schema +
 * rules — byte-identical across requests) is marked with cache_control so
 * every generation after the first reads it at ~10% input price; `volatile`
 * (registry index, dashboard state, attachments) follows uncached.
 */
export interface SystemPrompt {
  stable: string;
  volatile: string;
}

export async function generateText(opts: {
  system: string;
  user: string;
  maxTokens?: number;
  /** Images attached to the request, sent to Claude as vision blocks. */
  images?: ImageInput[];
  /** Aborts the underlying HTTP request when the client cancels. */
  signal?: AbortSignal;
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

  const response = await getClient().messages.create(
    {
      model: config.model,
      max_tokens: opts.maxTokens ?? 16000,
      system: opts.system,
      messages: [{ role: "user", content }],
    },
    { signal: opts.signal },
  );
  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  const tokens = response.usage.input_tokens + response.usage.output_tokens;
  return { text, tokens };
}

/**
 * Structured-output generation: the response is grammar-constrained to the
 * given Zod schema (always valid JSON — no prose, no markdown fences). The
 * schema must be flat/strict (no recursion, no open records); recursive
 * payloads ride inside JSON-string fields and are validated server-side.
 */
export async function generateObject<T>(opts: {
  system: SystemPrompt;
  user: string;
  schema: z.ZodType<T>;
  maxTokens?: number;
  images?: ImageInput[];
  signal?: AbortSignal;
}): Promise<{ value: T; tokens: number }> {
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

  const system: Anthropic.TextBlockParam[] = [
    {
      type: "text",
      text: opts.system.stable,
      cache_control: { type: "ephemeral" },
    },
  ];
  if (opts.system.volatile.trim()) {
    system.push({ type: "text", text: opts.system.volatile });
  }

  const response = await getClient().messages.parse(
    {
      model: config.model,
      max_tokens: opts.maxTokens ?? 16000,
      system,
      messages: [{ role: "user", content }],
      output_config: { format: zodOutputFormat(opts.schema) },
    },
    { signal: opts.signal },
  );

  const tokens = response.usage.input_tokens + response.usage.output_tokens;
  const cacheRead = response.usage.cache_read_input_tokens ?? 0;
  const cacheWrite = response.usage.cache_creation_input_tokens ?? 0;
  console.log(
    `[llm] in=${response.usage.input_tokens} out=${response.usage.output_tokens} cache_read=${cacheRead} cache_write=${cacheWrite}`,
  );
  if (response.stop_reason === "refusal") {
    throw new Error("the model declined to generate this content");
  }
  if (response.parsed_output == null) {
    throw new Error(
      response.stop_reason === "max_tokens"
        ? "the model response was truncated (max_tokens)"
        : "the model returned no parseable structured output",
    );
  }
  return { value: response.parsed_output, tokens };
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
