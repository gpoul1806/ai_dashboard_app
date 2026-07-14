import {
  type Attachment,
  type CapabilitySpec,
  type ComponentSpec,
  type Plan,
  type WidgetDefinition,
  attachmentKind,
  capabilityKey,
  componentKey,
} from "@myday/schema";
import type { z } from "zod";
import { config } from "../config";
import type { CapabilityRow, ComponentRow, Db, FeatureRow } from "../db";
import {
  explainFailure,
  generateObject,
  type ImageInput,
  type SystemPrompt,
  llmAvailable,
} from "../llm/client";
import {
  plannerSystem,
  tier1System,
  tier2System,
  tier3System,
} from "../llm/prompts";
import {
  type Validated,
  validateCapabilitySpec,
  validatePlan,
  validateTier1Wire,
  validateTier2Wire,
} from "../llm/validators";
import {
  PlanWireSchema,
  Tier1WireSchema,
  Tier2WireSchema,
  Tier3WireSchema,
} from "../llm/wire";
import type { SandboxRuntime } from "../sandbox";

export type OrchestratorResult =
  | {
      status: "ok";
      feature: FeatureRow;
      cached: boolean;
      /** Capability keys generated this run that still need dev approval. */
      pendingApprovals: string[];
      /** Pieces of a decomposed request that failed after their own retry —
       *  partial success instead of failing the whole batch. */
      failedPieces: Array<{ plan: string; reason: string }>;
    }
  | {
      status: "removed";
      /** Widgets deleted from the dashboard by this request. */
      removed: Array<{ id: string; name: string }>;
    }
  | {
      status: "declined";
      /** LLM-authored, user-facing explanation of exactly why it couldn't be built. */
      reason: string;
    };

/** Heuristic gate: does the request look like a manage/remove command? Used
 *  only to bypass the create-cache so the planner can classify intent — the
 *  planner remains the authority on what actually happens. */
function looksLikeManagement(text: string): boolean {
  return /\b(remove|delete|hide|get rid of|take (?:down|away)|clear|dismiss|close)\b/i.test(
    text,
  );
}

/**
 * Runs an LLM generation step with one retry (errors appended), then fails.
 * The response is structured output (grammar-constrained to the wire schema),
 * so JSON syntax can never fail — retries only fire on semantic/sanitizer
 * violations reported by `validate`.
 */
async function generateValidated<W, T>(
  step: string,
  system: SystemPrompt,
  user: string,
  wireSchema: z.ZodType<W>,
  validate: (wire: W) => Validated<T> | Promise<Validated<T>>,
  onLog: (tokens: number, retries: number, success: boolean) => void,
  images: ImageInput[] = [],
  signal?: AbortSignal,
): Promise<T> {
  let lastErrors: string[] = [];
  let totalTokens = 0;
  // Degrade gracefully if an attached image can't be processed by the model:
  // drop the images and continue text-only (the widget can still show the
  // image via its URL — the model just won't have "seen" it).
  let useImages = images;
  for (let attempt = 0; attempt < 2; attempt++) {
    const prompt =
      attempt === 0
        ? user
        : `${user}\n\nYour previous response was invalid. Fix these problems and return a corrected response:\n${lastErrors
            .map((e) => `- ${e}`)
            .join("\n")}`;
    let wire: W;
    let tokens: number;
    try {
      ({ value: wire, tokens } = await generateObject({
        system,
        user: prompt,
        schema: wireSchema,
        images: useImages,
        signal,
      }));
    } catch (err) {
      if (signal?.aborted) throw err; // client cancelled — propagate, don't retry
      if (useImages.length > 0) {
        console.warn(
          `[${step}] vision call failed (${(err as Error).message}) — retrying text-only`,
        );
        useImages = [];
        attempt--; // don't consume a validation attempt on the image fallback
        continue;
      }
      throw err;
    }
    totalTokens += tokens;

    const result = await validate(wire);
    if (result.ok) {
      onLog(totalTokens, attempt, true);
      return result.value;
    }
    lastErrors = result.errors;
  }
  onLog(totalTokens, 1, false);
  // Surface the technical validation errors in the server log — the user only
  // ever sees the friendly explainFailure paraphrase.
  console.warn(`[${step}] failed after retry:\n${lastErrors.map((e) => `  - ${e}`).join("\n")}`);
  throw new Error(`${step} failed after retry: ${lastErrors.join("; ")}`);
}

/** Worker pool: runs fn over items with at most `limit` in flight — the
 *  "agent team" primitive. Never rejects; each piece settles independently. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<Array<PromiseSettledResult<R>>> {
  const results: Array<PromiseSettledResult<R>> = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { status: "fulfilled", value: await fn(items[i], i) };
      } catch (err) {
        results[i] = { status: "rejected", reason: err };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

/** How many worker agents build pieces concurrently. Read at call time so
 *  tests can pin it to 1 (deterministic FIFO mocks). */
function workerConcurrency(): number {
  return Math.max(1, Number(process.env.GENERATION_CONCURRENCY ?? 3) || 1);
}

function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "feature"
  );
}

export class Orchestrator {
  constructor(
    private db: Db,
    private sandbox: SandboxRuntime,
  ) {}

  /** Ensures every persisted+approved capability is live in the sandbox. */
  async hydrateSandbox(): Promise<void> {
    for (const cap of await this.db.listCapabilities()) {
      if (cap.approved && !this.sandbox.has(cap.key)) {
        await this.sandbox.register(cap.spec);
      }
    }
  }

  async handleRequest(
    requestText: string,
    attachments: Attachment[] = [],
    signal?: AbortSignal,
  ): Promise<OrchestratorResult> {
    if (!llmAvailable()) {
      throw new Error(
        "ANTHROPIC_API_KEY is not set — the generative pipeline needs Claude. Add it to apps/server/.env.",
      );
    }

    const components = await this.db.listComponents();
    const capabilities = await this.db.listCapabilities();
    const currentFeatures = await this.db.listFeatures();
    // Load image attachments as vision blocks so the planner/component gen can
    // actually see screenshots/photos (not just their filenames).
    const images = await this.loadImages(attachments);

    // Management requests (remove/delete/hide …) must never be short-circuited
    // by the create-cache — that's how "remove the todo list" used to serve a
    // fabricated "acknowledged" widget. Route them straight to the planner.
    const isManagement = looksLikeManagement(requestText);
    const useCache = attachments.length === 0 && !isManagement;

    // Cache check — skip when files are attached (each upload is unique, so a
    // prior text-similar feature would point at the wrong asset) or when the
    // request looks like a management command.
    if (useCache) {
      const candidates = await this.db.findSimilarFeatures(requestText, 5);
      const best = candidates[0];
      if (best && best.similarity >= config.similarityThreshold) {
        // The cache outlives the dashboard ("Clear all" only empties the
        // layout) — re-surface the cached widget.
        await this.db.addToLayout(best.feature.id);
        await this.log(requestText, "cache", true, true, 0, 0);
        return { status: "ok", feature: best.feature, cached: true, pendingApprovals: [], failedPieces: [] };
      }
    }
    const candidates = useCache ? await this.db.findSimilarFeatures(requestText, 5) : [];

    // Plan. A planner failure (e.g. model/API error) becomes an explained
    // decline rather than a 500 — the app degrades gracefully.
    let plan: Plan;
    try {
      plan = await generateValidated(
        "planner",
        plannerSystem(components, capabilities, candidates, currentFeatures, attachments),
        `User request: ${requestText}`,
        PlanWireSchema,
        validatePlan,
        (tokens, retries, success) =>
          void this.log(requestText, "plan", false, success, retries, tokens),
        images,
        signal,
      );
    } catch (err) {
      if (signal?.aborted) throw err; // client cancelled — let the route drop it
      const technical = err instanceof Error ? err.message : String(err);
      return { status: "declined", reason: await explainFailure(requestText, technical) };
    }

    // Removal: delete the matched widgets instead of building anything.
    if (plan.intent === "remove") {
      const ids = new Set(plan.removeFeatureIds);
      const targets = currentFeatures.filter((f) => ids.has(f.id));
      if (targets.length === 0) {
        return {
          status: "declined",
          reason:
            plan.declineReason ||
            "I couldn't find a widget matching that to remove. Check the widget name and try again.",
        };
      }
      const removed: Array<{ id: string; name: string }> = [];
      for (const f of targets) {
        if (await this.db.deleteFeature(f.id)) removed.push({ id: f.id, name: f.name });
      }
      await this.log(requestText, "plan", false, true, 0, 0);
      return { status: "removed", removed };
    }

    // Feasibility gate: the planner decided this can't be fulfilled here
    // (needs a key/account/impossible). Decline gracefully with its reason.
    if (!plan.feasible) {
      await this.log(requestText, "plan", false, false, 0, 0);
      return { status: "declined", reason: plan.declineReason };
    }

    if (plan.cacheHit) {
      const cached = await this.db.getFeature(plan.cacheHit);
      if (cached) {
        await this.db.addToLayout(cached.id);
        await this.log(requestText, "cache", true, true, 0, 0);
        return { status: "ok", feature: cached, cached: true, pendingApprovals: [], failedPieces: [] };
      }
    }

    // Tier 3 → Tier 2 → Tier 1, each validated before the next runs. Any hard
    // failure (e.g. no keyless capability survives validation+retry) becomes an
    // explained decline rather than a 500.
    try {
      const pendingApprovals = await this.runTier3(requestText, plan, signal);
      await this.runTier2(requestText, plan, attachments, images, signal);
      // Fan out: every piece (new widget or in-place update) is built by an
      // independent worker agent with its own retry. One failing piece never
      // kills the batch — it lands in failedPieces instead.
      const limit = workerConcurrency();
      const buildPlans = [plan.widgetPlan, ...plan.moreWidgetPlans].filter((p) => p.trim());
      const failedPieces: Array<{ plan: string; reason: string }> = [];

      const built = await mapLimit(buildPlans, limit, (p) =>
        this.runTier1(requestText, p, attachments, signal),
      );
      if (signal?.aborted) throw new Error("Request was aborted");
      const features: FeatureRow[] = [];
      built.forEach((r, i) => {
        if (r.status === "fulfilled") features.push(r.value);
        else failedPieces.push({ plan: buildPlans[i], reason: String((r.reason as Error)?.message ?? r.reason) });
      });

      // Modify existing widgets in place (cross-widget wiring, restyles…).
      const updatedResults = await mapLimit(plan.updatePlans, limit, (u) =>
        this.runUpdate(requestText, u.featureId, u.instruction, signal),
      );
      if (signal?.aborted) throw new Error("Request was aborted");
      const updated: FeatureRow[] = [];
      updatedResults.forEach((r, i) => {
        if (r.status === "fulfilled") {
          if (r.value) updated.push(r.value);
        } else {
          failedPieces.push({
            plan: plan.updatePlans[i].instruction,
            reason: String((r.reason as Error)?.message ?? r.reason),
          });
        }
      });

      // Re-home existing widgets onto views (e.g. the current table → "home"
      // when a tab menu is created). Applied only after the builds succeeded
      // so a failed pipeline can't strand widgets on invisible views.
      await this.applyViewAssignments(plan);

      const primary = features[0] ?? updated[0];
      if (!primary) {
        if (failedPieces.length > 0) {
          const technical = failedPieces.map((f) => f.reason).join("; ");
          return { status: "declined", reason: await explainFailure(requestText, technical) };
        }
        return {
          status: "declined",
          reason: "The request didn't produce or change any widget — try rephrasing it.",
        };
      }
      return { status: "ok", feature: primary, cached: false, pendingApprovals, failedPieces };
    } catch (err) {
      if (signal?.aborted) throw err; // client cancelled — let the route drop it
      const technical = err instanceof Error ? err.message : String(err);
      const reason = await explainFailure(requestText, technical);
      return { status: "declined", reason };
    }
  }

  /** Reads image attachments from storage as base64 vision inputs. */
  private async loadImages(attachments: Attachment[]): Promise<ImageInput[]> {
    const images: ImageInput[] = [];
    for (const a of attachments) {
      if (attachmentKind(a.mimeType) !== "image") continue;
      const upload = await this.db.getUpload(a.id);
      if (upload) images.push({ mediaType: upload.mimeType, dataBase64: upload.dataBase64 });
    }
    return images;
  }

  /* -------------------- Tier 3 -------------------- */

  private async runTier3(
    requestText: string,
    plan: Plan,
    signal?: AbortSignal,
  ): Promise<string[]> {
    const pendingApprovals: string[] = [];
    for (const need of plan.needsCapabilities) {
      const spec = await generateValidated(
        "tier3",
        tier3System(),
        `User request: ${requestText}\n\nGenerate this capability: id "${need.id}" — ${need.description}\nUse version 1.`,
        Tier3WireSchema,
        validateCapabilitySpec,
        (tokens, retries, success) =>
          void this.log(requestText, "tier3", false, success, retries, tokens),
        [],
        signal,
      );
      spec.version = 1;
      const key = capabilityKey(spec);

      // review_required = true for NEW capabilities (safety rail #5): stored,
      // NOT registered in the sandbox until a human approves in the dev panel.
      await this.db.insertCapability({
        key,
        name: spec.name,
        version: spec.version,
        description: spec.description,
        spec,
        domainAllowlist: spec.domainAllowlist,
        reviewRequired: true,
        approved: false,
      });
      pendingApprovals.push(key);
    }
    return pendingApprovals;
  }

  /* -------------------- Tier 2 -------------------- */

  private async runTier2(
    requestText: string,
    plan: Plan,
    attachments: Attachment[],
    images: ImageInput[],
    signal?: AbortSignal,
  ): Promise<void> {
    if (plan.needsComponents.length === 0) return;
    const capabilities = await this.db.listCapabilities();

    for (const need of plan.needsComponents) {
      const spec = await generateValidated(
        "tier2",
        tier2System(capabilities, attachments),
        `User request: ${requestText}\n\nGenerate this component: id "${need.id}" — ${need.description}\nUse version 1. If it needs external data, call it through useCapability with one of the available capability keys. If it renders an attachment, take the url as a prop and use it directly in src/href.`,
        Tier2WireSchema,
        validateTier2Wire,
        (tokens, retries, success) =>
          void this.log(requestText, "tier2", false, success, retries, tokens),
        images,
        signal,
      );
      spec.version = 1;
      const key = componentKey(spec);
      await this.db.insertComponent({
        key,
        name: spec.name,
        version: spec.version,
        description: spec.description,
        propsSchema: spec.propsSchema,
        source: spec.source,
        builtJs: spec.builtJs,
      });
    }
  }

  /* -------------------- Tier 1 -------------------- */

  private async applyViewAssignments(plan: Plan): Promise<void> {
    for (const { featureId, view } of plan.viewAssignments) {
      // Guard against junk assignments ("" or invalid names) — an empty view
      // must mean "global", which is expressed by NOT assigning, not by "".
      if (!/^[a-z0-9-]+$/.test(view)) continue;
      const feature = await this.db.getFeature(featureId);
      if (!feature) continue;
      feature.definition.presentation = {
        ...feature.definition.presentation,
        view,
      };
      await this.db.updateFeatureDefinition(featureId, feature.definition);
    }
  }

  /** Regenerates ONE existing widget in place (same id) — a worker-agent piece. */
  private async runUpdate(
    requestText: string,
    featureId: string,
    instruction: string,
    signal?: AbortSignal,
  ): Promise<FeatureRow | null> {
    const existing = await this.db.getFeature(featureId);
    if (!existing) return null;
    const components = await this.db.listComponents();
    const capabilities = await this.db.listCapabilities();
    const componentKeys = new Set(components.map((c) => c.key));

    const def = await generateValidated(
      "tier1",
      tier1System(components, capabilities),
      `User request: ${requestText}\n\nUPDATE an existing widget. Its CURRENT definition:\n${JSON.stringify(existing.definition)}\n\nApply exactly this change: ${instruction}\n\nReturn the FULL updated WidgetDefinition — keep the same "id" and "name", keep everything not affected by the change identical, and bump nothing else.`,
      Tier1WireSchema,
      (wire) => validateTier1Wire(wire, componentKeys),
      (tokens, retries, success) =>
        void this.log(requestText, "tier1", false, success, retries, tokens),
      [],
      signal,
    );
    def.id = existing.id;
    def.version = existing.version + 1;
    await this.db.updateFeatureDefinition(existing.id, def);
    await this.db.addToLayout(existing.id);
    return { ...existing, definition: def };
  }

  private async runTier1(
    requestText: string,
    widgetPlan: string,
    attachments: Attachment[],
    signal?: AbortSignal,
  ): Promise<FeatureRow> {
    const components = await this.db.listComponents();
    const capabilities = await this.db.listCapabilities();
    const componentKeys = new Set(components.map((c) => c.key));

    const attachNote =
      attachments.length > 0
        ? `\n\nAttachment URLs to wire in:\n${attachments
            .map((a) => `- ${a.filename}: ${a.url}`)
            .join("\n")}`
        : "";
    const def = await generateValidated(
      "tier1",
      tier1System(components, capabilities, attachments),
      `User request: ${requestText}\n\nCompose this widget: ${widgetPlan}${attachNote}`,
      Tier1WireSchema,
      (wire) => validateTier1Wire(wire, componentKeys),
      (tokens, retries, success) =>
        void this.log(requestText, "tier1", false, success, retries, tokens),
      [],
      signal,
    );

    const id = `${slugify(def.id || def.name)}-${Date.now().toString(36)}`;
    def.id = id;

    const feature = await this.db.insertFeature({
      id,
      slug: id,
      name: def.name,
      description: def.description,
      definition: def,
      version: def.version,
    });
    return feature;
  }

  private log(
    requestText: string,
    tier: "cache" | "plan" | "tier1" | "tier2" | "tier3",
    cacheHit: boolean,
    success: boolean,
    retries: number,
    tokens: number,
  ): Promise<void> {
    return this.db
      .insertLog({ requestText, tier, cacheHit, success, retries, tokens })
      .catch((err) => console.error("[log] failed", err));
  }
}
