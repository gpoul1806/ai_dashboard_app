import { AttachmentSchema } from "@myday/schema";
import { Router } from "express";
import { z } from "zod";
import type { Db, FeatureRow } from "../db";
import { HttpError } from "../config";
import type { Orchestrator } from "../orchestrator";

const AttachmentsSchema = z.array(AttachmentSchema).max(10).default([]);

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
      const parsedAttachments = AttachmentsSchema.safeParse(
        (req.body as { attachments?: unknown })?.attachments ?? [],
      );
      if (!parsedAttachments.success) throw new HttpError(400, "invalid attachments");
      const attachments = parsedAttachments.data;
      if (!text && attachments.length === 0) {
        throw new HttpError(400, "request text or an attachment is required");
      }

      // Cancellation: when the client aborts the fetch, the connection closes.
      // Abort the request-scoped signal so the orchestrator stops the in-flight
      // Claude calls (and stops spending tokens) instead of running to completion.
      const ac = new AbortController();
      const onClose = () => ac.abort();
      req.on("close", onClose);

      try {
        const result = await orchestrator.handleRequest(
          text || "Build a widget that displays the attached file(s).",
          attachments,
          ac.signal,
        );
        // A declined request is a normal (200) outcome, not an error — the
        // client shows a toast + the LLM's collapsible explanation.
        if (result.status === "declined") {
          res.json({ declined: true, reason: result.reason });
        } else {
          res.json({
            declined: false,
            feature: toApi(result.feature),
            cached: result.cached,
            pendingApprovals: result.pendingApprovals,
          });
        }
      } catch (err) {
        if (ac.signal.aborted) return; // client cancelled — nothing to send back
        throw err;
      } finally {
        req.off("close", onClose);
      }
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
