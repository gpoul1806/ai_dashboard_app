import {
  type CapabilitySpec,
  type ComponentSpec,
  type Plan,
  type WidgetDefinition,
  capabilityKey,
  componentKey,
} from "@myday/schema";
import { config } from "../config";
import type { CapabilityRow, ComponentRow, Db, FeatureRow } from "../db";
import { generateText, llmAvailable } from "../llm/client";
import {
  plannerSystem,
  tier1System,
  tier2System,
  tier3System,
} from "../llm/prompts";
import {
  type Validated,
  extractJson,
  validateCapabilitySpec,
  validateComponentSpec,
  validatePlan,
  validateWidgetDefinition,
} from "../llm/validators";
import type { SandboxRuntime } from "../sandbox";

export interface OrchestratorResult {
  feature: FeatureRow;
  cached: boolean;
  /** Capability keys generated this run that still need dev approval. */
  pendingApprovals: string[];
}

/** Runs an LLM generation step with one retry (errors appended), then fails. */
async function generateValidated<T>(
  step: string,
  system: string,
  user: string,
  validate: (raw: unknown) => Validated<T> | Promise<Validated<T>>,
  onLog: (tokens: number, retries: number, success: boolean) => void,
): Promise<T> {
  let lastErrors: string[] = [];
  let totalTokens = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    const prompt =
      attempt === 0
        ? user
        : `${user}\n\nYour previous response was invalid. Fix these problems and return corrected JSON only:\n${lastErrors
            .map((e) => `- ${e}`)
            .join("\n")}`;
    const { text, tokens } = await generateText({ system, user: prompt });
    totalTokens += tokens;

    const json = extractJson(text);
    if (!json.ok) {
      lastErrors = json.errors;
      continue;
    }
    const result = await validate(json.value);
    if (result.ok) {
      onLog(totalTokens, attempt, true);
      return result.value;
    }
    lastErrors = result.errors;
  }
  onLog(totalTokens, 1, false);
  throw new Error(`${step} failed after retry: ${lastErrors.join("; ")}`);
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

  async handleRequest(requestText: string): Promise<OrchestratorResult> {
    if (!llmAvailable()) {
      throw new Error(
        "ANTHROPIC_API_KEY is not set — the generative pipeline needs Claude. Add it to apps/server/.env.",
      );
    }

    const components = await this.db.listComponents();
    const capabilities = await this.db.listCapabilities();

    // Cache check (feature similarity via pg_trgm / trigram fallback).
    const candidates = await this.db.findSimilarFeatures(requestText, 5);
    const best = candidates[0];
    if (best && best.similarity >= config.similarityThreshold) {
      await this.log(requestText, "cache", true, true, 0, 0);
      return { feature: best.feature, cached: true, pendingApprovals: [] };
    }

    // Plan.
    const plan = await generateValidated<Plan>(
      "planner",
      plannerSystem(components, capabilities, candidates),
      `User request: ${requestText}`,
      validatePlan,
      (tokens, retries, success) =>
        void this.log(requestText, "plan", false, success, retries, tokens),
    );

    if (plan.cacheHit) {
      const cached = await this.db.getFeature(plan.cacheHit);
      if (cached) {
        await this.log(requestText, "cache", true, true, 0, 0);
        return { feature: cached, cached: true, pendingApprovals: [] };
      }
    }

    // Tier 3 → Tier 2 → Tier 1, each validated before the next runs.
    const pendingApprovals = await this.runTier3(requestText, plan);
    await this.runTier2(requestText, plan);
    const feature = await this.runTier1(requestText, plan);

    return { feature, cached: false, pendingApprovals };
  }

  /* -------------------- Tier 3 -------------------- */

  private async runTier3(requestText: string, plan: Plan): Promise<string[]> {
    const pendingApprovals: string[] = [];
    for (const need of plan.needsCapabilities) {
      const spec = await generateValidated<CapabilitySpec>(
        "tier3",
        tier3System(),
        `User request: ${requestText}\n\nGenerate this capability: id "${need.id}" — ${need.description}\nUse version 1.`,
        validateCapabilitySpec,
        (tokens, retries, success) =>
          void this.log(requestText, "tier3", false, success, retries, tokens),
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

  private async runTier2(requestText: string, plan: Plan): Promise<void> {
    if (plan.needsComponents.length === 0) return;
    const capabilities = await this.db.listCapabilities();

    for (const need of plan.needsComponents) {
      const spec = await generateValidated<ComponentSpec & { builtJs: string }>(
        "tier2",
        tier2System(capabilities),
        `User request: ${requestText}\n\nGenerate this component: id "${need.id}" — ${need.description}\nUse version 1. If it needs external data, call it through useCapability with one of the available capability keys.`,
        validateComponentSpec,
        (tokens, retries, success) =>
          void this.log(requestText, "tier2", false, success, retries, tokens),
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

  private async runTier1(requestText: string, plan: Plan): Promise<FeatureRow> {
    const components = await this.db.listComponents();
    const capabilities = await this.db.listCapabilities();
    const componentKeys = new Set(components.map((c) => c.key));

    const def = await generateValidated<WidgetDefinition>(
      "tier1",
      tier1System(components, capabilities),
      `User request: ${requestText}\n\nCompose this widget: ${plan.widgetPlan}`,
      (raw) => validateWidgetDefinition(raw, componentKeys),
      (tokens, retries, success) =>
        void this.log(requestText, "tier1", false, success, retries, tokens),
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
