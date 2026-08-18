// Fork-local (iTerm2 mode, R14): POST /api/attach-file — the host half of dropping / picking
// ANY file over a pane. The generalisation of paste-image.ts, which stays image-only because a
// clipboard paste really is a screenshot; a drop or the header attach button is not.
//
// Same store, same answer shape, for the same reasons: the workspace attachment store is the
// one place to sweep, and the ABSOLUTE path is what a pane running in any directory can use.
// The saved name keeps the (host-sanitised) original stem and extension, so the agent reading
// the inserted path knows what it was handed.
import path from "node:path";
import type { Express, Request, Response } from "express";
import { decodeAttachFile, ATTACH_FILE_ROUTE, type AttachFileResponse } from "../../common/attachFile.js";
import { messageOf } from "../errors.js";

export interface AttachFileDeps {
  /** The workspace root the attachment store writes under; also what the relative path is
   *  relative to. */
  workspace: string;
  isAllowedOrigin: (origin: string | undefined, remoteAddress: string | undefined) => boolean;
  /** Persist the bytes and report where they landed (createSaveAttachment). */
  saveAttachment: (base64Data: string, mimeType: string, fileName?: string) => Promise<{ relativePath: string; mimeType: string }>;
}

async function attachFile(req: Request, res: Response, deps: AttachFileDeps): Promise<void> {
  if (!deps.isAllowedOrigin(req.headers.origin, req.socket?.remoteAddress)) {
    res.status(403).json({ error: "forbidden origin" });
    return;
  }
  const decision = decodeAttachFile(req.body);
  if (!decision.ok) {
    res.status(decision.status).json({ error: decision.error });
    return;
  }
  try {
    // The MIME is unknowable here (Chrome reports "" for most text files); the store names
    // by fileName when one is given, so octet-stream is only ever a fallback label.
    const saved = await deps.saveAttachment(decision.request.dataBase64, "application/octet-stream", decision.request.fileName);
    const body: AttachFileResponse = { ok: true, path: path.join(deps.workspace, saved.relativePath), relativePath: saved.relativePath };
    res.json(body);
  } catch (err) {
    // The file is lost either way, so say so rather than leaving the cell showing "saving".
    console.warn(`[attach-file] save failed: ${messageOf(err)}`);
    res.status(500).json({ error: "couldn't save the attached file" });
  }
}

export function mountAttachFileRoute(app: Express, deps: AttachFileDeps): void {
  // The promise is RETURNED so Express 5 routes a rejection to the error middleware instead
  // of it becoming an unhandled rejection (the same reason paste-image does).
  app.post(ATTACH_FILE_ROUTE, (req, res) => attachFile(req, res, deps));
}
