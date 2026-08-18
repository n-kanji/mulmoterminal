// @vitest-environment node
import { describe, it, expect } from "vitest";

import { ATTACHMENTS_DIR, attachmentNameParts, extensionForMime, yearMonthUtc } from "../../../../server/backends/remoteHost/attachment-path.js";

describe("extensionForMime", () => {
  it.each([
    ["image/png", ".png"],
    ["image/jpeg", ".jpg"],
    ["image/jpg", ".jpg"], // deliberately the same as image/jpeg
    ["image/webp", ".webp"],
    ["image/gif", ".gif"],
    ["image/heic", ".heic"],
    ["image/heif", ".heif"],
    ["image/tiff", ".tif"], // .tif, not .tiff — pinned so it isn't "corrected"
    ["application/pdf", ".pdf"],
    ["text/plain", ".txt"],
    ["text/markdown", ".md"],
    ["text/csv", ".csv"],
  ])("maps %s to %s", (mime, ext) => {
    expect(extensionForMime(mime)).toBe(ext);
  });

  // Case-insensitive: a phone that sends an upper-cased MIME must map the same.
  it.each([
    ["IMAGE/PNG", ".png"],
    ["Application/PDF", ".pdf"],
    ["Image/Jpeg", ".jpg"],
  ])("is case-insensitive for %s", (mime, ext) => {
    expect(extensionForMime(mime)).toBe(ext);
  });

  // Regression (#746): a Content-Type may carry parameters or surrounding space; the bare
  // type must still resolve, not fall through to .bin.
  it.each([
    ["text/plain; charset=utf-8", ".txt"],
    ["text/csv;charset=UTF-8", ".csv"],
    ["  image/png  ", ".png"],
    ["application/pdf ; foo=bar", ".pdf"],
  ])("strips parameters/space from %j", (mime, ext) => {
    expect(extensionForMime(mime)).toBe(ext);
  });

  // Anything unmapped falls back to .bin — never a guessed extension.
  it.each(["application/octet-stream", "image/bmp", "video/mp4", "", "not-a-mime"])("falls back to .bin for %j", (mime) => {
    expect(extensionForMime(mime)).toBe(".bin");
  });
});

describe("yearMonthUtc", () => {
  // getUTCMonth is 0-indexed, so the +1 and the zero-pad both have to be right — January must
  // read "01", not "00" or "0".
  it.each<[number, number, string]>([
    [2026, 0, "2026/01"], // January — the +1 boundary
    [2026, 8, "2026/09"], // September — single digit, zero-padded
    [2026, 9, "2026/10"], // October — two digits, not over-padded
    [2026, 11, "2026/12"], // December — the top of the range
    [1999, 0, "1999/01"], // year passes through verbatim
  ])("formats %d-%d as %s", (year, monthIndex, expected) => {
    expect(yearMonthUtc(new Date(Date.UTC(year, monthIndex, 15, 12, 0, 0)))).toBe(expected);
  });

  // Reads UTC fields, not local ones: an instant that is still January 1st in UTC partitions as
  // 2026/01 regardless of the runner's timezone.
  it("uses UTC calendar fields", () => {
    expect(yearMonthUtc(new Date(Date.UTC(2026, 0, 1, 0, 0, 0)))).toBe("2026/01");
  });
});

describe("ATTACHMENTS_DIR", () => {
  it("is the workspace-relative attachments root", () => {
    expect(ATTACHMENTS_DIR).toBe("data/attachments");
  });
});

describe("attachmentNameParts", () => {
  // The attach-file route's naming rule. This is the ONE security-sensitive derivation on the
  // path from a client string to a filename on disk, so the hostile shapes are pinned first.
  it.each([
    ["../../etc/passwd.md", "passwd", ".md"], // traversal → basename only
    ["..\\..\\x.md", "x", ".md"], // Windows-style traversal too
    ["a/b/c.txt", "c", ".txt"], // any path → its basename
    [".env", "env", ""], // a leading dot is not an extension marker
    ["..", "file", ""], // nothing left → the fallback stem
    ["", "file", ""],
  ])("defuses %j to %j + %j", (name, stem, ext) => {
    expect(attachmentNameParts(name)).toEqual({ stem, ext });
  });

  it.each([
    ["企画書.md", "企画書", ".md"], // non-ASCII survives — the insert shell-quotes it
    ["notes.MD", "notes", ".md"], // extension lower-cased
    ["a b.md", "a b", ".md"], // spaces survive, same reason as 企画書
    ["archive.tar.gz", "archive.tar", ".gz"], // only the LAST extension is the extension
    ["Makefile", "Makefile", ""], // extensionless stays extensionless — no guessed .bin
    ["name..md", "name", ".md"], // stray dots don't survive at the stem's edge
    ['we:*?"<>|ird.md', "weird", ".md"], // Windows-reserved punctuation stripped
    ["a\u0000b\u001fc.md", "abc", ".md"], // control characters stripped
    ["file.superlongextension", "file.superlongextension", ""], // >10 chars is not an extension
  ])("keeps what identifies %j (→ %j + %j)", (name, stem, ext) => {
    expect(attachmentNameParts(name)).toEqual({ stem, ext });
  });

  it("caps a runaway stem without touching the extension", () => {
    const { stem, ext } = attachmentNameParts(`${"x".repeat(200)}.md`);
    expect(stem).toBe("x".repeat(64));
    expect(ext).toBe(".md");
  });
});
