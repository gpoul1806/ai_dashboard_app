import { Router } from "express";
import type { Db, FeatureRow } from "../db";
import { HttpError } from "../config";
import type { Orchestrator } from "../orchestrator";

function toApi(feature: FeatureRow) {
  return {
    id: feature.id,
    slug: feature.slug,
    name: feature.name,
    description: feature.description,
    version: feature.version,
    definition: feature.definition,
    createdAt: feature.createdAt,
  };
}

export function featuresRouter(db: Db, orchestrator: Orchestrator): Router {
  const router = Router();

  router.get("/", async (_req, res, next) => {
    try {
      const features = await db.listFeatures();
      res.json(features.map(toApi));
    } catch (err) {
      next(err);
    }
  });

  router.post("/request", async (req, res, next) => {
    try {
      const text = String((req.body as { text?: unknown })?.text ?? "").trim();
      if (!text) throw new HttpError(400, "request text is required");
      const result = await orchestrator.handleRequest(text);
      // A declined request is a normal (200) outcome, not an error — the client
      // shows a toast + the LLM's collapsible explanation.
      if (result.status === "declined") {
        res.json({ declined: true, reason: result.reason });
        return;
      }
      res.json({
        declined: false,
        feature: toApi(result.feature),
        cached: result.cached,
        pendingApprovals: result.pendingApprovals,
      });
    } catch (err) {
      next(err);
    }
  });

  router.get("/:id", async (req, res, next) => {
    try {
      const feature = await db.getFeature(req.params.id);
      if (!feature) throw new HttpError(404, "feature not found");
      res.json(toApi(feature));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
