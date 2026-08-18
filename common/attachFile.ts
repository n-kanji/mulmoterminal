// Fork-local (iTerm2 mode, R14): attaching ANY file to a pane — the generalisation of the
// image-only pipeline in pasteImage.ts.
//
// A drop and the header attach button hand over File objects whose PATH the browser withholds,
// so the bytes go to the host, which writes them into the workspace attachment store and
// answers with a path to insert. Keyed on FILENAME, not MIME: Chrome reports an empty
// `File.type` for .md and most text files, so a MIME whitelist cannot even see the files this
// route exists for. The saved name keeps the original stem and extension (sanitised host-side)
// so the inserted path still tells the agent what it is looking at.
//
// BOTH sides decide from this file: the browser refuses a file it knows the host will reject
// (so nothing is uploaded to be thrown away), and the route re-checks the same rules on what
// it actually received. The limits are therefore stated once, here.
import { isRecord } from "./isRecord.js";
import { base64Bytes, isBareBase64, MAX_PASTE_IMAGE_BYTES } from "./pasteImage.js";

/** POST here with a dropped / picked file's bytes; the answer carries the path to insert. */
export const ATTACH_FILE_ROUTE = "/api/attach-file";

// The same ceiling as a paste, for the same reason: base64 in a JSON body under the host's
// 25 MB limit. Bigger than this wants a path, not an upload — the toolbar's file picker
// (pick-file) inserts the real path without copying anything.
export const MAX_ATTACH_FILE_BYTES = MAX_PASTE_IMAGE_BYTES;

// Longer than any real filename; only guards against a hostile / broken client, since the
// host derives the saved name from this string.
export const MAX_ATTACH_FILE_NAME_LENGTH = 255;

export interface AttachFileRequest {
  /** The file's name as the browser reported it, e.g. "企画書.md". The host sanitises it. */
  fileName: string;
  /** The raw bytes, base64 — no data: URL prefix. Empty is a legal (empty) file. */
  dataBase64: string;
}

export interface AttachFileResponse {
  ok: true;
  /** The saved file's ABSOLUTE path, so it can be inserted into a terminal in any directory. */
  path: string;
  /** Its workspace-relative path, for a caller that wants to show something shorter. */
  relativePath: string;
}

export type AttachFileDecision = { ok: true; request: AttachFileRequest } | { ok: false; status: number; error: string };

/** Validate a POST body against the rules above. Pure, so both the route's spec and the
 *  browser half can check a payload without a server. */
export function decodeAttachFile(body: unknown): AttachFileDecision {
  if (!isRecord(body)) return { ok: false, status: 400, error: "expected a JSON object" };
  const { fileName, dataBase64 } = body;
  if (typeof fileName !== "string" || fileName.length === 0 || fileName.length > MAX_ATTACH_FILE_NAME_LENGTH) {
    return { ok: false, status: 400, error: "fileName is required" };
  }
  if (typeof dataBase64 !== "string") return { ok: false, status: 400, error: "dataBase64 is required" };
  // "" is an empty file, which is fine; anything non-empty must be bare base64.
  if (dataBase64 !== "" && !isBareBase64(dataBase64)) return { ok: false, status: 400, error: "dataBase64 must be bare base64" };
  if (base64Bytes(dataBase64) > MAX_ATTACH_FILE_BYTES) return { ok: false, status: 413, error: "file too large" };
  return { ok: true, request: { fileName, dataBase64 } };
}
