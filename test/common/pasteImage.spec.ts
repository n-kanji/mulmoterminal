import { describe, it, expect } from "vitest";
import { base64Bytes, decodePasteImage, isPasteImageMime, MAX_PASTE_IMAGE_BYTES } from "../../common/pasteImage.js";

// The rules BOTH sides read (R10). The browser refuses a paste it knows the host would reject,
// and the route re-checks the same rules on the bytes it actually got — so these tests are the
// one place the two agree.

describe("isPasteImageMime", () => {
  it("accepts the screenshot formats, whatever the case or trailing parameters", () => {
    expect(isPasteImageMime("image/png")).toBe(true);
    expect(isPasteImageMime("IMAGE/PNG")).toBe(true);
    expect(isPasteImageMime("image/jpeg; charset=binary")).toBe(true);
    expect(isPasteImageMime("image/webp")).toBe(true);
  });

  // An unmapped type would be written as `.bin` by the attachment store, and a file no agent
  // can open is worse than a paste that reports it did nothing.
  it("refuses anything the attachment store has no extension for", () => {
    expect(isPasteImageMime("image/svg+xml")).toBe(false);
    expect(isPasteImageMime("application/pdf")).toBe(false);
    expect(isPasteImageMime("text/plain")).toBe(false);
    expect(isPasteImageMime("")).toBe(false);
  });
});

describe("base64Bytes", () => {
  it("reports the decoded size without decoding, padding included", () => {
    expect(base64Bytes("")).toBe(0);
    expect(base64Bytes(btoa("a"))).toBe(1); // "YQ==" — two pad chars
    expect(base64Bytes(btoa("ab"))).toBe(2); // "YWI=" — one
    expect(base64Bytes(btoa("abc"))).toBe(3); // "YWJj" — none
    expect(base64Bytes(btoa("hello world"))).toBe(11);
  });
});

describe("decodePasteImage", () => {
  const body = (over: Record<string, unknown> = {}) => ({ mimeType: "image/png", dataBase64: btoa("bytes"), ...over });

  it("accepts a well-formed image paste", () => {
    const decision = decodePasteImage(body());
    expect(decision).toEqual({ ok: true, request: { mimeType: "image/png", dataBase64: btoa("bytes") } });
  });

  it("415s an unsupported type and 400s a missing one", () => {
    expect(decodePasteImage(body({ mimeType: "image/svg+xml" }))).toMatchObject({ ok: false, status: 415 });
    expect(decodePasteImage(body({ mimeType: undefined }))).toMatchObject({ ok: false, status: 415 });
  });

  it("400s a body that is not an object, or has no data", () => {
    expect(decodePasteImage(null)).toMatchObject({ ok: false, status: 400 });
    expect(decodePasteImage("nope")).toMatchObject({ ok: false, status: 400 });
    expect(decodePasteImage(body({ dataBase64: "" }))).toMatchObject({ ok: false, status: 400 });
  });

  // A data: URL is the shape a careless caller sends; decoding it as base64 writes a file whose
  // first bytes are the prefix — a corrupt image that LOOKS saved. Refuse instead of guessing.
  it("400s a data: URL or anything else that isn't bare base64", () => {
    expect(decodePasteImage(body({ dataBase64: `data:image/png;base64,${btoa("x")}` }))).toMatchObject({ ok: false, status: 400 });
    expect(decodePasteImage(body({ dataBase64: "not base64!" }))).toMatchObject({ ok: false, status: 400 });
  });

  it("413s a paste over the size ceiling", () => {
    const oversize = "A".repeat(Math.ceil((MAX_PASTE_IMAGE_BYTES + 1024) * (4 / 3)));
    expect(decodePasteImage(body({ dataBase64: oversize }))).toMatchObject({ ok: false, status: 413 });
  });
});
