// dotenv: loads apps/server/.env so the Anthropic key stays server-side.
import "dotenv/config";

export const config = {
  port: Number(process.env.PORT ?? 3001),
  model: process.env.LLM_MODEL ?? "claude-sonnet-4-6",
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || null,
  supabaseUrl: process.env.SUPABASE_URL || null,
  supabaseKey: process.env.SUPABASE_SERVICE_ROLE_KEY || null,
  sandboxEngine: (process.env.SANDBOX === "worker" ? "worker" : "auto") as
    | "auto"
    | "worker",
  /** v1 auth: hardcoded demo user. No RLS yet. */
  demoUserId: "demo-user",
  /** pg_trgm-style similarity above this serves the cached feature. */
  similarityThreshold: 0.6,
};

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
