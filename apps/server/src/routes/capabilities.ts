import { Router } from "express";
import type { CapabilityRow, Db } from "../db";
import { HttpError } from "../config";
import type { SandboxRuntime } from "../sandbox";

function toApi(cap: CapabilityRow) {
  return {
    key: cap.key,
    name: cap.name,
    description: cap.description,
    domainAllowlist: cap.domainAllowlist,
    reviewRequired: cap.reviewRequired,
    approved: cap.approved,
  };
}

/** Capability index + the one-click dev approval endpoint (safety rail #5). */
export function capabilitiesRouter(db: Db, sandbox: SandboxRuntime): Router {
  const router = Router();

  router.get("/", async (_req, res, next) => {
    try {
      const caps = await db.listCapabilities();
      res.json(caps.map(toApi));
    } catch (err) {
      next(err);
    }
  });

  router.post("/:key/approve", async (req, res, next) => {
    try {
      const cap = await db.getCapability(req.params.key);
      if (!cap) throw new HttpError(404, "capability not found");
      const updated = await db.setCapabilityApproved(cap.key, true);
      if (!updated) throw new HttpError(500, "failed to approve capability");
      // Approval is the gate that registers the handlers in the sandbox.
      if (!sandbox.has(updated.key)) await sandbox.register(updated.spec);
      res.json(toApi(updated));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
