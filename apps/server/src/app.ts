import cors from "cors";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { HttpError } from "./config";
import type { Db } from "./db";
import type { Orchestrator } from "./orchestrator";
import { capabilitiesRouter } from "./routes/capabilities";
import { componentsRouter } from "./routes/components";
import { dataRouter } from "./routes/data";
import { dynRouter } from "./routes/dyn";
import { featuresRouter } from "./routes/features";
import type { SandboxRuntime } from "./sandbox";

export function createApp(deps: {
  db: Db;
  orchestrator: Orchestrator;
  sandbox: SandboxRuntime;
}): Express {
  const { db, orchestrator, sandbox } = deps;
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "1mb" }));

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, db: db.kind, sandbox: sandbox.engine });
  });

  app.use("/api/features", featuresRouter(db, orchestrator));
  app.use("/api/components", componentsRouter(db));
  app.use("/api/capabilities", capabilitiesRouter(db, sandbox));
  app.use("/api/data", dataRouter(db));
  app.use("/api/dyn", dynRouter(db, sandbox));

  // Centralized error handler → JSON { error }.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = err instanceof HttpError ? err.status : 500;
    const message = err instanceof Error ? err.message : String(err);
    if (status >= 500) console.error("[error]", err);
    res.status(status).json({ error: message });
  });

  return app;
}
