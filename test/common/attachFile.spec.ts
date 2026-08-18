import { describe, it, expect } from "vitest";
import { ATTACH_FILE_ROUTE, MAX_ATTACH_FILE_BYTES, MAX_ATTACH_FILE_NAME_LENGTH, decodeAttachFile } from "../../common/attachFile.js";
import { MAX_PASTE_IMAGE_BYTES } from "../../common/pasteImage.js";

// The any-file sibling of decodePasteImage: keyed on fileName instead of a MIME whitelist,
// because Chrome reports an empty File.type for .md and most text files.

const B64 = btoa("some file bytes");

describe("decodeAttachFile", () => {
  it("accepts a named file and hands back the request verbatim", () => {
    expect(decodeAttachFile({ fileName: "企画書.md", dataBase64: B64 })).toEqual({ ok: true, request: { fileName: "企画書.md", dataBase64: B64 } });
  });

  // An empty file is a legal file (a marker .md, a fresh note) — refusing it would read as
  // the feature being broken for exactly the least surprising drop.
  it("accepts an empty payload as an empty file", () => {
    expect(decodeAttachFile({ fileName: "empty.md", dataBase64: "" })).toEqual({ ok: true, request: { fileName: "empty.md", dataBase64: "" } });
  });

  it("rejects a body that is not an object", () => {
    for (const body of [null, "x", 42, ["a"]]) {
      expect(decodeAttachFile(body)).toMatchObject({ ok: false, status: 400 });
    }
  });

  it("requires a fileName that is a non-empty string of sane length", () => {
    expect(decodeAttachFile({ dataBase64: B64 })).toMatchObject({ ok: false, status: 400 });
    expect(decodeAttachFile({ fileName: "", dataBase64: B64 })).toMatchObject({ ok: false, status: 400 });
    expect(decodeAttachFile({ fileName: 7, dataBase64: B64 })).toMatchObject({ ok: false, status: 400 });
    expect(decodeAttachFile({ fileName: "x".repeat(MAX_ATTACH_FILE_NAME_LENGTH + 1), dataBase64: B64 })).toMatchObject({ ok: false, status: 400 });
    // Exactly at the cap is still a name.
    expect(decodeAttachFile({ fileName: "x".repeat(MAX_ATTACH_FILE_NAME_LENGTH), dataBase64: B64 })).toMatchObject({ ok: true });
  });

  it("rejects a payload that is not bare base64", () => {
    expect(decodeAttachFile({ fileName: "a.md", dataBase64: 7 })).toMatchObject({ ok: false, status: 400 });
    expect(decodeAttachFile({ fileName: "a.md", dataBase64: `data:text/markdown;base64,${B64}` })).toMatchObject({ ok: false, status: 400 });
    expect(decodeAttachFile({ fileName: "a.md", dataBase64: "abc\ndef=" })).toMatchObject({ ok: false, status: 400 });
  });

  it("413s an oversized file", () => {
    const oversize = "A".repeat(Math.ceil((MAX_ATTACH_FILE_BYTES + 1024) * (4 / 3)));
    expect(decodeAttachFile({ fileName: "big.bin", dataBase64: oversize })).toMatchObject({ ok: false, status: 413 });
  });
});

describe("the shared limits", () => {
  // Same JSON-body reasoning as a paste; if the two ever diverge, that is a decision, not drift.
  it("caps an attachment exactly where a paste is capped", () => {
    expect(MAX_ATTACH_FILE_BYTES).toBe(MAX_PASTE_IMAGE_BYTES);
  });

  it("names the route both sides POST/mount", () => {
    expect(ATTACH_FILE_ROUTE).toBe("/api/attach-file");
  });
});
