// Fork-local (iTerm2 mode, R10): the browser half of "Cmd+V an image into a pane".
//
// A clipboard image has no path — it is bytes, which is exactly why a drop cannot stand in for
// it. So the bytes go to the host (POST /api/paste-image), which writes them into the workspace
// attachment store and answers with a path; the path is then typed into the pane like any
// dropped file's would be.
//
// Split into pure pieces because a ClipboardEvent cannot be built faithfully in jsdom: the
// item-picking rule and the upload are each testable with a plain object / a stubbed fetch,
// and the component is left with the two lines that wire them together.
import { PASTE_IMAGE_ROUTE, isPasteImageMime, MAX_PASTE_IMAGE_BYTES, type PasteImageRequest } from "../../common/pasteImage";
import { ATTACH_FILE_ROUTE, MAX_ATTACH_FILE_BYTES, type AttachFileRequest } from "../../common/attachFile";

// The parts of DataTransfer this reads. Typed structurally so a spec can hand over a literal —
// `new DataTransfer()` is not constructible in jsdom, and `items` is not an array.
export interface ClipboardLike {
  items?: ArrayLike<{ kind: string; type: string; getAsFile(): File | null }>;
  files?: ArrayLike<File>;
}

/** The first pasted image the host will accept, or null.
 *
 *  `items` first, then `files`: copying an image in a browser produces an item with no
 *  corresponding entry in `files` in some engines, and copying a file from the OS file manager
 *  produces the reverse. A paste that also carries text (the usual case for a screenshot tool)
 *  still finds the image, which is what makes this worth doing at all. */
export function pastedImageFile(data: ClipboardLike | null | undefined): File | null {
  if (!data) return null;
  const items = data.items ?? [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.kind !== "file" || !isPasteImageMime(item.type)) continue;
    const file = item.getAsFile();
    if (file) return file;
  }
  const files = data.files ?? [];
  for (let i = 0; i < files.length; i++) {
    if (isPasteImageMime(files[i].type)) return files[i];
  }
  return null;
}

// btoa on a 15 MB string built with String.fromCharCode(...bytes) blows the argument limit, so
// the string is built in chunks. 8k keeps every call far under any engine's cap.
const CHUNK = 8192;

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Why a paste did not produce a path. `too-large` is refused HERE, before the upload, so the
 *  operator is not made to wait on bytes the host would reject anyway. */
export type PasteImageFailure = "too-large" | "unreadable" | "upload-failed";

export type PasteImageOutcome = { ok: true; path: string } | { ok: false; reason: PasteImageFailure };

/** Send one clipboard image to the host and report the path it landed at. `fetchImpl` is
 *  injected so a spec never touches the network. */
export async function uploadPastedImage(file: File, fetchImpl: typeof fetch = fetch): Promise<PasteImageOutcome> {
  if (file.size > MAX_PASTE_IMAGE_BYTES) return { ok: false, reason: "too-large" };
  let body: PasteImageRequest;
  try {
    body = { mimeType: file.type, dataBase64: bytesToBase64(new Uint8Array(await file.arrayBuffer())) };
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  try {
    const res = await fetchImpl(PASTE_IMAGE_ROUTE, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) return { ok: false, reason: "upload-failed" };
    const data = await res.json();
    return typeof data?.path === "string" && data.path ? { ok: true, path: data.path } : { ok: false, reason: "upload-failed" };
  } catch {
    return { ok: false, reason: "upload-failed" };
  }
}

// What the cell shows for a moment instead of raising a toast — same reasoning as the copy
// buttons: a floating notice over one of thirty columns is chrome that costs a reading line.
// Worded for a FILE, not an image: the attach path below shares these, and a pasted image is
// a file too. `unreadable` is also what a dropped FOLDER lands on (reading it throws).
const FAILURE_LABEL: Record<PasteImageFailure, string> = {
  "too-large": "ファイルが大きすぎます",
  unreadable: "ファイルを読めませんでした",
  "upload-failed": "保存に失敗しました",
};

export const pasteFailureLabel = (reason: PasteImageFailure): string => FAILURE_LABEL[reason];

// ---- Dropped / picked files, ANY kind (the sibling of the paste path above) ----
//
// A drop and the header attach button both hand over File objects whose PATH the browser
// withholds, so they ride the same shape of upload: bytes to the host, path back, path into
// the pane. Unlike the paste half these take EVERY file, and they post to the attach-file
// route keyed on filename — Chrome reports an empty `File.type` for .md and most text files,
// so a MIME filter cannot even see the files this exists for.

/** A drop's / a picker's FileList as a plain array (jsdom specs hand over literals). */
export function filesFrom(files: ArrayLike<File> | null | undefined): File[] {
  const out: File[] = [];
  if (!files) return out;
  for (let i = 0; i < files.length; i++) out.push(files[i]);
  return out;
}

/** Send one dropped / picked file to the host and report the path it landed at. A dropped
 *  FOLDER also arrives as a File; reading it throws, which lands on `unreadable`. */
export async function uploadAttachmentFile(file: File, fetchImpl: typeof fetch = fetch): Promise<PasteImageOutcome> {
  if (file.size > MAX_ATTACH_FILE_BYTES) return { ok: false, reason: "too-large" };
  let body: AttachFileRequest;
  try {
    body = { fileName: file.name || "file", dataBase64: bytesToBase64(new Uint8Array(await file.arrayBuffer())) };
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  try {
    const res = await fetchImpl(ATTACH_FILE_ROUTE, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) return { ok: false, reason: "upload-failed" };
    const data = await res.json();
    return typeof data?.path === "string" && data.path ? { ok: true, path: data.path } : { ok: false, reason: "upload-failed" };
  } catch {
    return { ok: false, reason: "upload-failed" };
  }
}

export interface UploadFilesOutcome {
  /** Host paths for every file that made it, in the order given. */
  paths: string[];
  /** The last failure, if any file did not make it. */
  failed: PasteImageFailure | null;
}

/** Upload several files sequentially (the host writes to one attachment store; parallelism
 *  buys nothing and interleaves failure messages). Partial success keeps the paths it got. */
export async function uploadAttachmentFiles(files: File[], fetchImpl: typeof fetch = fetch): Promise<UploadFilesOutcome> {
  const paths: string[] = [];
  let failed: PasteImageFailure | null = null;
  for (const file of files) {
    const outcome = await uploadAttachmentFile(file, fetchImpl);
    if (outcome.ok) paths.push(outcome.path);
    else failed = outcome.reason;
  }
  return { paths, failed };
}
