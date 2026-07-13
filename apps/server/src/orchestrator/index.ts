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
import { config } from "../config";
import type { CapabilityRow, ComponentRow, Db, FeatureRow } from "../db";
import {
  explainFailure,
  generateText,
  type ImageInput,
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
  extractJson,
  validateCapabilitySpec,
  validateComponentSpec,
  validatePlan,
  validateWidgetDefinition,
} from "../llm/validators";
import type { SandboxRuntime } from "../sandbox";

export type OrchestratorResult =
  | {
      status: "ok";
      feature: FeatureRow;
      cached: boolean;
      /** Capability keys generated this run that still need dev approval. */
      pendingApprovals: string[];
    }
  | {
      status: "declined";
      /** LLM-authored, user-facing explanation of exactly why it couldn't be built. */
      reason: string;
    };

/** Runs an LLM generation step with one retry (errors appended), then fails. */
async function generateValidated<T>(
  step: string,
  system: string,
  user: string,
  validate: (raw: unknown) => Validated<T> | Promise<Validated<T>>,
  onLog: (tokens: number, retries: number, success: boolean) => void,
  images: ImageInput[] = [],
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
        : `${user}\n\nYour previous response was invalid. Fix these problems and return corrected JSON only:\n${lastErrors
            .map((e) => `- ${e}`)
            .join("\n")}`;
    let text: string;
    let tokens: number;
    try {
      ({ text, tokens } = await generateText({ system, user: prompt, images: useImages }));
    } catch (err) {
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

  async handleRequest(
    requestText: string,
    attachments: Attachment[] = [],
  ): Promise<OrchestratorResult> {
    if (!llmAvailable()) {
      throw new Error(
        "ANTHROPIC_API_KEY is not set — the generative pipeline needs Claude. Add it to apps/server/.env.",
      );
    }

    const components = await this.db.listComponents();
    const capabilities = await this.db.listCapabilities();
    // Load image attachments as vision blocks so the planner/component gen can
    // actually see screenshots/photos (not just their filenames).
    const images = await this.loadImages(attachments);

    // Cache check — skip when files are attached (each upload is unique, so a
    // prior text-similar feature would point at the wrong asset).
    if (attachments.length === 0) {
      const candidates = await this.db.findSimilarFeatures(requestText, 5);
      const best = candidates[0];
      if (best && best.similarity >= config.similarityThreshold) {
        await this.log(requestText, "cache", true, true, 0, 0);
        return { status: "ok", feature: best.feature, cached: true, pendingApprovals: [] };
      }
    }
    const candidates =
      attachments.length === 0 ? await this.db.findSimilarFeatures(requestText, 5) : [];

    // Plan. A planner failure (e.g. model/API error) becomes an explained
    // decline rather than a 500 — the app degrades gracefully.
    let plan: Plan;
    try {
      plan = await generateValidated<Plan>(
        "planner",
        plannerSystem(components, capabilities, candidates, attachments),
        `User request: ${requestText}`,
        validatePlan,
        (tokens, retries, success) =>
          void this.log(requestText, "plan", false, success, retries, tokens),
        images,
      );
    } catch (err) {
      const technical = err instanceof Error ? err.message : String(err);
      return { status: "declined", reason: await explainFailure(requestText, technical) };
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
        await this.log(requestText, "cache", true, true, 0, 0);
        return { status: "ok", feature: cached, cached: true, pendingApprovals: [] };
      }
    }

    // Tier 3 → Tier 2 → Tier 1, each validated before the next runs. Any hard
    // failure (e.g. no keyless capability survives validation+retry) becomes an
    // explained decline rather than a 500.
    try {
      const pendingApprovals = await this.runTier3(requestText, plan);
      await this.runTier2(requestText, plan, attachments, images);
      const feature = await this.runTier1(requestText, plan, attachments);
      return { status: "ok", feature, cached: false, pendingApprovals };
    } catch (err) {
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

  private async runTier2(
    requestText: string,
    plan: Plan,
    attachments: Attachment[],
    images: ImageInput[],
  ): Promise<void> {
    if (plan.needsComponents.length === 0) return;
    const capabilities = await this.db.listCapabilities();

    for (const need of plan.needsComponents) {
      const spec = await generateValidated<ComponentSpec & { builtJs: string }>(
        "tier2",
        tier2System(capabilities, attachments),
        `User request: ${requestText}\n\nGenerate this component: id "${need.id}" — ${need.description}\nUse version 1. If it needs external data, call it through useCapability with one of the available capability keys. If it renders an attachment, take the url as a prop and use it directly in src/href.`,
        validateComponentSpec,
        (tokens, retries, success) =>
          void this.log(requestText, "tier2", false, success, retries, tokens),
        images,
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

  private async runTier1(
    requestText: string,
    plan: Plan,
    attachments: Attachment[],
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
    const def = await generateValidated<WidgetDefinition>(
      "tier1",
      tier1System(components, capabilities, attachments),
      `User request: ${requestText}\n\nCompose this widget: ${plan.widgetPlan}${attachNote}`,
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
