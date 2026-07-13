import { Router } from "express";
import { config, HttpError } from "../config";
import type { Db } from "../db";

/** widget_data CRUD for the hardcoded demo user (v1: no auth/RLS). */
export function dataRouter(db: Db): Router {
  const router = Router();
  const userId = config.demoUserId;

  const toApi = (r: { id: string; row: Record<string, unknown> }) => ({
    id: r.id,
    row: r.row,
  });

  router.get("/:featureId", async (req, res, next) => {
    try {
      const rows = await db.listWidgetData(req.params.featureId, userId);
      res.json(rows.map(toApi));
    } catch (err) {
      next(err);
    }
  });

  router.post("/:featureId", async (req, res, next) => {
    try {
      const row = (req.body as { row?: unknown })?.row;
      if (!row || typeof row !== "object") throw new HttpError(400, "row object is required");
      const created = await db.insertWidgetData(
        req.params.featureId,
        userId,
        row as Record<string, unknown>,
      );
      res.json(toApi(created));
    } catch (err) {
      next(err);
    }
  });

  router.patch("/:featureId/:rowId", async (req, res, next) => {
    try {
      const patch = (req.body as { patch?: unknown })?.patch;
      if (!patch || typeof patch !== "object") throw new HttpError(400, "patch object is required");
      const updated = await db.updateWidgetData(
        req.params.featureId,
        userId,
        req.params.rowId,
        patch as Record<string, unknown>,
      );
      if (!updated) throw new HttpError(404, "row not found");
      res.json(toApi(updated));
    } catch (err) {
      next(err);
    }
  });

  router.delete("/:featureId/:rowId", async (req, res, next) => {
    try {
      await db.deleteWidgetData(req.params.featureId, userId, req.params.rowId);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  return router;
}
