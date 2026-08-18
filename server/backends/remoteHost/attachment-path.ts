// Pure path/naming rules for the workspace attachment store: the extension a MIME maps to, and
// the UTC YYYY/MM partition an upload lands in. Split out of attachmentStore's file I/O so both
// can be tested without touching disk — a mis-cased extension or an off-by-one month partition is
// invisible once the bytes are already written.

export const ATTACHMENTS_DIR = "data/attachments";

// MIME → extension. Narrow on purpose (covers phone photos + PDFs + a few text types); anything
// unmapped falls back to `.bin` so we never guess. Case-insensitive so "IMAGE/PNG" maps the same
// as "image/png".
const MIME_EXT: Readonly<Record<string, string>> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/heic": ".heic", // iOS default capture format
  "image/heif": ".heif",
  "image/tiff": ".tif",
  "application/pdf": ".pdf",
  "text/plain": ".txt",
  "text/markdown": ".md",
  "text/csv": ".csv",
};

// A Content-Type may carry parameters ("text/plain; charset=utf-8") or surrounding space;
// the extension map is keyed by the bare type, so strip everything from the first ";" and
// trim before the lower-cased lookup — otherwise a charset-bearing text upload falls to .bin.
export const extensionForMime = (mimeType: string): string => MIME_EXT[mimeType.split(";")[0].trim().toLowerCase()] ?? ".bin";

// ---- Client-supplied filenames (the attach-file route) ----
//
// The browser reports a NAME but no path, and for .md / most text files no MIME either — so
// the saved name is derived from the name, not the type. The stem survives (an agent told to
// read ".../企画書-<uuid>.md" knows what it is looking at; ".../<uuid>.bin" does not), the
// UUID guarantees uniqueness (same collision reasoning as attachmentStore), and everything a
// path could be attacked or broken with is stripped HERE, on the host — a client check
// doesn't count.

// What a stem must not carry: path separators (handled first, below), Windows-reserved
// punctuation, and control characters. Everything else — Japanese included — survives,
// because the terminal insert already shell-quotes non-ASCII.
// eslint-disable-next-line no-control-regex
const STEM_STRIP = /[\u0000-\u001f\u007f/\\:*?"<>|]/g;

// An extension worth keeping: short and alphanumeric. Anything else (no dot, a 40-char
// "extension", trailing punctuation) is treated as extensionless rather than guessed at.
const EXT_RE = /\.[A-Za-z0-9]{1,10}$/;

const MAX_STEM_LENGTH = 64;

export interface AttachmentNameParts {
  /** Sanitised stem, never empty. */
  stem: string;
  /** Lower-cased extension including its dot, or "" for an extensionless name. */
  ext: string;
}

// Edge-trim dots and whitespace by index (an anchored `[.\s]+$` regex is super-linear on a
// hostile string; this is one pass). Leading dots go so ".env" is the file "env" and ".."
// can never survive into a name.
const isDotOrSpace = (ch: string): boolean => ch === "." || ch.trim() === "";
function trimDotsAndSpace(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && isDotOrSpace(s[start])) start++;
  while (end > start && isDotOrSpace(s[end - 1])) end--;
  return s.slice(start, end);
}

export function attachmentNameParts(fileName: string): AttachmentNameParts {
  // Take the basename first, whichever separator the client used.
  const base = fileName.split(/[/\\]/).pop() ?? "";
  // Strip forbidden characters, then dots/whitespace at either edge.
  const clean = trimDotsAndSpace(base.replace(STEM_STRIP, ""));
  const extMatch = EXT_RE.exec(clean);
  const ext = extMatch ? extMatch[0].toLowerCase() : "";
  const stem = trimDotsAndSpace(clean.slice(0, clean.length - ext.length)).slice(0, MAX_STEM_LENGTH);
  return { stem: stem || "file", ext };
}

// UTC YYYY/MM partition so a workspace with many uploads stays browsable. getUTCMonth is
// 0-indexed, hence +1; zero-padded to two digits. UTC (not local) so the partition a file lands
// in doesn't drift with the server's timezone.
export const yearMonthUtc = (when: Date): string => `${when.getUTCFullYear()}/${String(when.getUTCMonth() + 1).padStart(2, "0")}`;
