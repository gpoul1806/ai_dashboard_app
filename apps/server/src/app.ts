import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
import { uploadsRouter } from "./routes/uploads";
import type { SandboxRuntime } from "./sandbox";

export function createApp(deps: {
  db: Db;
  orchestrator: Orchestrator;
  sandbox: SandboxRuntime;
}): Express {
  const { db, orchestrator, sandbox } = deps;
  const app = express();
  app.use(cors());
  // Limit accommodates base64-encoded file attachments (uploads route caps at 20 MB/file).
  app.use(express.json({ limit: "30mb" }));

  // Per-request access log → stdout (visible in Render's Logs tab). One line
  // per request: method, path, status, duration. Static SPA assets are skipped
  // so generation/API traffic stays readable.
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!req.path.startsWith("/api")) return next();
    const start = Date.now();
    res.on("finish", () => {
      console.log(`[req] ${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - start}ms`);
    });
    next();
  });

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, db: db.kind, sandbox: sandbox.engine });
  });

  app.use("/api/features", featuresRouter(db, orchestrator));
  app.use("/api/components", componentsRouter(db));
  app.use("/api/capabilities", capabilitiesRouter(db, sandbox));
  app.use("/api/data", dataRouter(db));
  app.use("/api/uploads", uploadsRouter(db));
  app.use("/api/dyn", dynRouter(db, sandbox));

  // Production single-service: serve the built SPA and let client-side routing
  // handle any non-/api path (deep links → index.html). Skipped in dev, where
  // Vite serves the SPA and proxies /api here — the dist dir won't exist.
  const here = path.dirname(fileURLToPath(import.meta.url)); // apps/server/src
  const webDist = path.resolve(here, "../../web/dist");
  if (existsSync(webDist)) {
    app.use(express.static(webDist));
    app.get("*", (req, res, next) => {
      if (req.path.startsWith("/api")) return next(); // let unknown /api 404 normally
      res.sendFile(path.join(webDist, "index.html"));
    });
    console.log(`[server] serving SPA from ${webDist}`);
  }

  // Centralized error handler → JSON { error }.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = err instanceof HttpError ? err.status : 500;
    const message = err instanceof Error ? err.message : String(err);
    if (status >= 500) console.error("[error]", err);
    res.status(status).json({ error: message });
  });

  return app;
}
