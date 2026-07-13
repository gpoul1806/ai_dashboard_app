import { randomUUID } from "node:crypto";
import { Router } from "express";
import { HttpError } from "../config";
import type { Db } from "../db";

/**
 * Stores files attached to a request (images, screenshots, audio, any type)
 * and serves them back at a same-origin URL so the shell and generated
 * components can use them directly as <img>/<audio>/<video>/<a> src/href —
 * no capability needed. The client uploads base64 JSON (no multipart dep).
 */
export function uploadsRouter(db: Db): Router {
  const router = Router();
  const MAX_BYTES = 20 * 1024 * 1024; // 20 MB per file

  router.post("/", async (req, res, next) => {
    try {
      const body = req.body as {
        filename?: unknown;
        mimeType?: unknown;
        dataBase64?: unknown;
      };
      const filename = String(body.filename ?? "").trim() || "file";
      const mimeType = String(body.mimeType ?? "application/octet-stream");
      const dataBase64 = String(body.dataBase64 ?? "");
      if (!dataBase64) throw new HttpError(400, "dataBase64 is required");

      const size = Buffer.byteLength(dataBase64, "base64");
      if (size > MAX_BYTES) {
        throw new HttpError(413, `file too large (max ${MAX_BYTES / (1024 * 1024)} MB)`);
      }

      const id = randomUUID();
      const upload = await db.insertUpload({ id, filename, mimeType, size, dataBase64 });
      res.json({
        id: upload.id,
        filename: upload.filename,
        mimeType: upload.mimeType,
        size: upload.size,
        url: `/api/uploads/${upload.id}`,
      });
    } catch (err) {
      next(err);
    }
  });

  // Only these types are safe to render inline from the app origin. Everything
  // else (HTML, SVG — which can carry scripts — PDFs, arbitrary files) is served
  // as an attachment so a direct navigation downloads it instead of executing it.
  // Images still render in widgets: <img>/<audio>/<video> load the bytes
  // regardless of Content-Disposition.
  const INLINE_SAFE = /^(?:image\/(?:png|jpeg|gif|webp)|audio\/[\w.+-]+|video\/[\w.+-]+)$/i;

  router.get("/:id", async (req, res, next) => {
    try {
      const upload = await db.getUpload(req.params.id);
      if (!upload) throw new HttpError(404, "upload not found");

      // Sanitize the filename before putting it in a header (strip CR/LF and
      // quote/backslash to prevent response-header injection), and carry the
      // full UTF-8 name via the RFC 5987 filename* form.
      const asciiName = upload.filename.replace(/[\r\n"\\]/g, "_").replace(/[^\x20-\x7e]/g, "_");
      const inline = INLINE_SAFE.test(upload.mimeType);
      const disposition = `${inline ? "inline" : "attachment"}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(upload.filename)}`;

      res.type(upload.mimeType);
      res.setHeader("Content-Disposition", disposition);
      // Defense in depth against a mistyped/malicious upload rendering as HTML:
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      res.send(Buffer.from(upload.dataBase64, "base64"));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
