import { Router, type Request } from "express";
import { HttpError } from "../config";
import type { Db } from "../db";
import type { SandboxRuntime } from "../sandbox";

/**
 * Mounts Tier 3 generated endpoints under /api/dyn/:capabilityKey/*.
 * Requests are dispatched into the sandbox; only approved+registered
 * capabilities are reachable.
 */
export function dynRouter(db: Db, sandbox: SandboxRuntime): Router {
  const router = Router();

  const handle = async (req: Request, capabilityKey: string) => {
    const cap = await db.getCapability(capabilityKey);
    if (!cap) throw new HttpError(404, `unknown capability ${capabilityKey}`);
    if (!cap.approved) {
      throw new HttpError(403, `capability ${capabilityKey} is awaiting approval`);
    }
    if (!sandbox.has(capabilityKey)) await sandbox.register(cap.spec);

    // Everything after the capability key is the handler path.
    const rest = req.params[0] ?? "";
    const path = `/${rest}`.replace(/\/+/g, "/");
    const query: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.query)) {
      query[k] = Array.isArray(v) ? String(v[0]) : String(v);
    }
    return sandbox.dispatch(capabilityKey, {
      method: req.method,
      path,
      query,
      body: req.body ?? null,
    });
  };

  router.all("/:key/*", async (req, res, next) => {
    try {
      const result = await handle(req, req.params.key);
      res.status(result.status).json(result.body);
    } catch (err) {
      next(err);
    }
  });

  // Bare capability path (no trailing subpath) → "/".
  router.all("/:key", async (req, res, next) => {
    try {
      const cap = await db.getCapability(req.params.key);
      if (!cap) throw new HttpError(404, `unknown capability ${req.params.key}`);
      if (!cap.approved) {
        throw new HttpError(403, `capability ${req.params.key} is awaiting approval`);
      }
      if (!sandbox.has(req.params.key)) await sandbox.register(cap.spec);
      const query: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.query)) {
        query[k] = Array.isArray(v) ? String(v[0]) : String(v);
      }
      const result = await sandbox.dispatch(req.params.key, {
        method: req.method,
        path: "/",
        query,
        body: req.body ?? null,
      });
      res.status(result.status).json(result.body);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
