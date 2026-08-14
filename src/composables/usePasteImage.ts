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
import { PASTE_IMAGE_ROUTE, PASTE_IMAGE_MIMES, isPasteImageMime, MAX_PASTE_IMAGE_BYTES, type PasteImageRequest } from "../../common/pasteImage";

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
const FAILURE_LABEL: Record<PasteImageFailure, string> = {
  "too-large": "画像が大きすぎます",
  unreadable: "画像を読めませんでした",
  "upload-failed": "保存に失敗しました",
};

export const pasteFailureLabel = (reason: PasteImageFailure): string => FAILURE_LABEL[reason];

// ---- Dropped / picked image files (the sibling of the paste path above) ----
//
// A drop and the photo button both hand over File objects whose PATH the browser withholds, so
// they ride the same upload: bytes to the host, path back, path into the pane. Split the same
// way as the paste half — a pure picker a spec can feed literals, and an async uploader with
// fetch injected.

/** The images the host will accept, out of a drop's / a picker's file list. */
export function imageFilesFrom(files: ArrayLike<File> | null | undefined): File[] {
  const out: File[] = [];
  if (!files) return out;
  for (let i = 0; i < files.length; i++) {
    if (isPasteImageMime(files[i].type)) out.push(files[i]);
  }
  return out;
}

/** The `accept` attribute for a file picker, stating exactly what the host takes — so the OS
 *  dialog steers the user away from a format that would only fail after the upload. */
export const IMAGE_PICKER_ACCEPT = PASTE_IMAGE_MIMES.join(",");

export interface UploadImagesOutcome {
  /** Host paths for every image that made it, in the order given. */
  paths: string[];
  /** The last failure, if any image did not make it. */
  failed: PasteImageFailure | null;
}

/** Upload several images sequentially (the host writes to one attachment store; parallelism
 *  buys nothing and interleaves failure messages). Partial success keeps the paths it got. */
export async function uploadImageFiles(files: File[], fetchImpl: typeof fetch = fetch): Promise<UploadImagesOutcome> {
  const paths: string[] = [];
  let failed: PasteImageFailure | null = null;
  for (const file of files) {
    const outcome = await uploadPastedImage(file, fetchImpl);
    if (outcome.ok) paths.push(outcome.path);
    else failed = outcome.reason;
  }
  return { paths, failed };
}
