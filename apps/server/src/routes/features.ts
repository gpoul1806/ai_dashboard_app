import { AttachmentSchema, type RequestOutcome } from "@myday/schema";
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

      // Cancellation: abort the in-flight generation when the client
      // disconnects (cancels the fetch). Listen on the RESPONSE, not the
      // request: req's "close" fires as soon as the POST body is consumed —
      // i.e. during every normal request — which would abort every request
      // mid-flight and hang the client. res "close" only fires early (before
      // the response finishes) on a real disconnect, so guard on writableEnded.
      const ac = new AbortController();
      const onClose = () => {
        if (!res.writableEnded) ac.abort();
      };
      res.on("close", onClose);

      try {
        const result = await orchestrator.handleRequest(
          text || "Build a widget that displays the attached file(s).",
          attachments,
          ac.signal,
        );
        // Every outcome — including a decline — is a normal 200 wrapped in the
        // generic RequestOutcome envelope (discriminated by "outcome").
        let outcome: RequestOutcome;
        if (result.status === "declined") {
          outcome = { outcome: "declined", userFacingReason: result.reason };
        } else if (result.status === "removed") {
          outcome = { outcome: "removed", removedWidgets: result.removed };
        } else {
          outcome = {
            outcome: "created",
            artifact: { kind: "widget", feature: toApi(result.feature) },
            servedFromCache: result.cached,
            pendingCapabilityApprovals: result.pendingApprovals,
            failedPieces: result.failedPieces ?? [],
          };
        }
        res.json(outcome);
      } catch (err) {
        if (ac.signal.aborted) return; // client cancelled — nothing to send back
        throw err;
      } finally {
        res.off("close", onClose);
      }
    } catch (err) {
      next(err);
    }
  });

  // "Clear all": empties the dashboard (user_layouts) but keeps every feature,
  // component, and capability cached — a later similar request is served
  // instantly from cache and re-surfaces the widget.
  router.post("/clear", async (_req, res, next) => {
    try {
      const cleared = await db.clearLayout();
      res.json({ cleared });
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
