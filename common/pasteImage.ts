// Fork-local (iTerm2 mode, R10): pasting an image into a pane.
//
// The operator screenshots constantly and then has to save the file somewhere before an agent
// can look at it. Cmd+V over a pane removes that step: the browser hands over the bitmap, the
// host writes it into the workspace attachment store, and the pane's input box gets the path —
// the same thing a file DROP already produces, from a clipboard the drop cannot reach.
//
// BOTH sides decide from this file: the browser refuses a paste it knows the host will reject
// (so nothing is uploaded to be thrown away), and the route re-checks the same rules on the
// bytes it actually received. The limits are therefore stated once, here.
import { isRecord } from "./isRecord.js";

/** POST here with the clipboard's image; the answer carries the path to insert. */
export const PASTE_IMAGE_ROUTE = "/api/paste-image";

// What a clipboard image may be. Deliberately the screenshot formats and nothing else: the
// attachment store maps an unknown MIME to `.bin`, and a file an agent cannot open is worse
// than a paste that says it did nothing.
export const PASTE_IMAGE_MIMES: readonly string[] = ["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"];

// A generous ceiling for a full-screen 5K screenshot, well under the 25 MB JSON body limit
// (base64 costs a third on top). Bigger than this is not a paste, it is a file — and a file
// has the drop path already.
export const MAX_PASTE_IMAGE_BYTES = 15 * 1024 * 1024;

export interface PasteImageRequest {
  /** The clipboard item's type, e.g. "image/png". */
  mimeType: string;
  /** The raw bytes, base64 — no data: URL prefix (the route rejects one rather than guessing). */
  dataBase64: string;
}

export interface PasteImageResponse {
  ok: true;
  /** The saved file's ABSOLUTE path, so it can be inserted into a terminal in any directory. */
  path: string;
  /** Its workspace-relative path, for a caller that wants to show something shorter. */
  relativePath: string;
}

/** A Content-Type may carry parameters ("image/png; foo=bar"); compare the bare type, cased
 *  as the map is — the same normalisation the attachment store's extension lookup does. */
export const isPasteImageMime = (mimeType: string): boolean => PASTE_IMAGE_MIMES.includes(mimeType.split(";")[0].trim().toLowerCase());

/** How many bytes a base64 payload decodes to, without decoding it — so an oversized paste is
 *  refused before it is turned into a Buffer. */
export function base64Bytes(data: string): number {
  const len = data.length;
  if (len === 0) return 0;
  const padding = data.endsWith("==") ? 2 : Number(data.endsWith("="));
  return Math.floor((len * 3) / 4) - padding;
}

/** Base64 as the browser's btoa/FileReader produce it. Rejects a data: URL prefix and any
 *  stray whitespace rather than silently writing a corrupt file. */
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

export type PasteImageDecision = { ok: true; request: PasteImageRequest } | { ok: false; status: number; error: string };

/** Validate a POST body against the rules above. Pure, so both the route's spec and a future
 *  caller can check a payload without a server. */
export function decodePasteImage(body: unknown): PasteImageDecision {
  if (!isRecord(body)) return { ok: false, status: 400, error: "expected a JSON object" };
  const { mimeType, dataBase64 } = body;
  if (typeof mimeType !== "string" || !isPasteImageMime(mimeType)) return { ok: false, status: 415, error: "unsupported image type" };
  if (typeof dataBase64 !== "string" || dataBase64.length === 0) return { ok: false, status: 400, error: "dataBase64 is required" };
  if (!BASE64_RE.test(dataBase64)) return { ok: false, status: 400, error: "dataBase64 must be bare base64" };
  if (base64Bytes(dataBase64) > MAX_PASTE_IMAGE_BYTES) return { ok: false, status: 413, error: "image too large" };
  return { ok: true, request: { mimeType, dataBase64 } };
}
