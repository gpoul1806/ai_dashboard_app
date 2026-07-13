import { Router } from "express";
import type { Db } from "../db";
import { HttpError } from "../config";

/** Serves generated component ES modules and a registry index. */
export function componentsRouter(db: Db): Router {
  const router = Router();

  router.get("/", async (_req, res, next) => {
    try {
      const components = await db.listComponents();
      res.json(
        components.map((c) => ({
          key: c.key,
          name: c.name,
          version: c.version,
          description: c.description,
        })),
      );
    } catch (err) {
      next(err);
    }
  });

  // The loader imports these as ES modules: /api/components/Image@1.js
  router.get("/:key.js", async (req, res, next) => {
    try {
      const component = await db.getComponent(req.params.key);
      if (!component) throw new HttpError(404, "component not found");
      res.type("application/javascript");
      // Generated modules import bare "react" / "@shell/hooks", resolved by the
      // client's import map to the shell's single React instance + hooks.
      res.send(component.builtJs);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
