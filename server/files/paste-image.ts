// Fork-local (iTerm2 mode, R10): POST /api/paste-image — the host half of "Cmd+V an image
// into a pane".
//
// It writes into the SAME workspace attachment store the phone's chat uploads use
// (backends/remoteHost/attachmentStore.ts): one store means one place to sweep, one naming
// rule, and one partition scheme. Nothing about that store is remote-specific — it was only
// ever reachable from the remote path because that was the only thing uploading.
//
// The answer is an ABSOLUTE path. A pane can be running anywhere, so a workspace-relative
// path would be wrong in every pane whose cwd is not the workspace; the relative one rides
// along for a caller that wants to show something shorter.
import path from "node:path";
import type { Express, Request, Response } from "express";
import { decodePasteImage, PASTE_IMAGE_ROUTE, type PasteImageResponse } from "../../common/pasteImage.js";
import { messageOf } from "../errors.js";

export interface PasteImageDeps {
  /** The workspace root the attachment store writes under; also what the relative path is
   *  relative to. */
  workspace: string;
  isAllowedOrigin: (origin: string | undefined, remoteAddress: string | undefined) => boolean;
  /** Persist the bytes and report where they landed (createSaveAttachment). */
  saveAttachment: (base64Data: string, mimeType: string) => Promise<{ relativePath: string; mimeType: string }>;
}

async function pasteImage(req: Request, res: Response, deps: PasteImageDeps): Promise<void> {
  if (!deps.isAllowedOrigin(req.headers.origin, req.socket?.remoteAddress)) {
    res.status(403).json({ error: "forbidden origin" });
    return;
  }
  const decision = decodePasteImage(req.body);
  if (!decision.ok) {
    res.status(decision.status).json({ error: decision.error });
    return;
  }
  try {
    const saved = await deps.saveAttachment(decision.request.dataBase64, decision.request.mimeType);
    const body: PasteImageResponse = { ok: true, path: path.join(deps.workspace, saved.relativePath), relativePath: saved.relativePath };
    res.json(body);
  } catch (err) {
    // The paste is lost either way, so say so rather than leaving the cell showing "uploading".
    console.warn(`[paste-image] save failed: ${messageOf(err)}`);
    res.status(500).json({ error: "couldn't save the pasted image" });
  }
}

export function mountPasteImageRoute(app: Express, deps: PasteImageDeps): void {
  // The promise is RETURNED so Express 5 routes a rejection to the error middleware instead
  // of it becoming an unhandled rejection (the same reason agent-routes does).
  app.post(PASTE_IMAGE_ROUTE, (req, res) => pasteImage(req, res, deps));
}
