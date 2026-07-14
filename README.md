# Add Features — Fully Generative Dashboard

Experimental **Fully Generative UI**. The client is a thin shell; the majority of
the app is served by the LLM as JSON (and, when needed, as generated code). Ask
for any feature in natural language; the server-side orchestrator decides how to
deliver it across three tiers, caches + versions everything, and grows its own
vocabulary.

- **Tier 1 — Compose:** build from existing components → widget JSON (fast path).
- **Tier 2 — New UI component:** LLM generates a React component; the server
  esbuild-transpiles + serves it as an ES module; the client dynamically imports
  and registers it.
- **Tier 3 — New server capability:** LLM generates a handler that runs in a
  sandbox (`isolated-vm`, falling back to `worker_threads`) with a strict
  `capFetch` / `capStore` capability API and a per-capability domain allowlist.

## Layout

```
packages/schema     Zod schemas for all three tiers (single source of truth)
apps/web            Thin shell: renderer engine + loader + seed primitives
apps/server         Express orchestrator + LLM + sandbox + db + routes
```

## Setup

```bash
pnpm install
cp apps/server/.env.example apps/server/.env   # add ANTHROPIC_API_KEY
pnpm dev            # web :5173 + server :3001
```

- **Without Supabase** the server uses an in-memory dev store (nothing persists
  across restarts). To persist, set `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`
  and apply `apps/server/src/db/schema.sql`.
- **Without `ANTHROPIC_API_KEY`** the seeded Todo widget still renders (Tiers
  2/3 need Claude). The key lives only in server `.env` — never exposed to the
  client or to sandboxed generated code.

## Commands

```bash
pnpm typecheck      # all packages
pnpm test           # vitest — schema + sandbox capability-API + orchestrator tests
pnpm dev            # dev servers
```

## Safety rails

1. Generated code never runs unsandboxed (Tier 2 in the browser page with import
   restrictions; Tier 3 in `isolated-vm`/`worker_threads` only).
2. All LLM output is validated (Zod / esbuild / static checks) before storage or
   execution, with one retry on failure.
3. Generated-code egress only via allowlisted `capFetch`.
4. Secrets are host-injected (`{{secret:NAME}}` placeholders), never LLM-visible.
5. New capabilities are `review_required`: stored but not registered in the
   sandbox until approved in the dev panel.

This is a proof of concept — auth, multi-tenancy, and hardening are deferred.
