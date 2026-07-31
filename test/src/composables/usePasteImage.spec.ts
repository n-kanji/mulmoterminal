import { describe, it, expect, vi } from "vitest";
import { bytesToBase64, pasteFailureLabel, pastedImageFile, uploadPastedImage, type ClipboardLike } from "../../../src/composables/usePasteImage";
import { MAX_PASTE_IMAGE_BYTES, PASTE_IMAGE_ROUTE } from "../../../common/pasteImage";

// A ClipboardEvent's DataTransfer cannot be built faithfully in jsdom (no DataTransfer
// constructor, and `items` is not an array), which is why the picking rule takes a structural
// type — a plain object is enough to pin the behaviour.
const item = (type: string, file: File | null) => ({ kind: file ? "file" : "string", type, getAsFile: () => file });
const png = (name = "shot.png", size = 4) => new File([new Uint8Array(size)], name, { type: "image/png" });

describe("pastedImageFile", () => {
  it("finds the image among a paste that also carries text", () => {
    const image = png();
    const data: ClipboardLike = { items: [item("text/plain", null), item("image/png", image)] };
    expect(pastedImageFile(data)).toBe(image);
  });

  // Engines disagree: an image copied in a browser can arrive as an item with nothing in
  // `files`, and a file copied from the OS file manager as the reverse. Both are a paste.
  it("falls back to `files` when the items list has no image", () => {
    const image = png();
    expect(pastedImageFile({ items: [item("text/plain", null)], files: [image] })).toBe(image);
  });

  it("is null for a plain text paste, an unsupported image, or no clipboard at all", () => {
    expect(pastedImageFile({ items: [item("text/plain", null)] })).toBeNull();
    expect(pastedImageFile({ files: [new File([], "d.svg", { type: "image/svg+xml" })] })).toBeNull();
    expect(pastedImageFile(null)).toBeNull();
    expect(pastedImageFile({})).toBeNull();
  });
});

describe("bytesToBase64", () => {
  it("round-trips through atob", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 255]);
    expect([...atob(bytesToBase64(bytes))].map((c) => c.charCodeAt(0))).toEqual([...bytes]);
  });

  // The reason it chunks: one fromCharCode call per megabyte would blow the argument limit,
  // and a 5K screenshot is several.
  it("handles a payload far past one chunk", () => {
    const bytes = new Uint8Array(20_000).fill(65);
    expect(atob(bytesToBase64(bytes))).toHaveLength(20_000);
  });
});

describe("uploadPastedImage", () => {
  // A FACTORY, not one shared mock: `vi.fn(anotherMock)` shares call state, so a second test
  // would see the first one's call and the "never posted" assertions would pass for free.
  const okFetch = () => vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, path: "/w/data/attachments/2026/08/a.png" }) }) as unknown as Response);

  it("posts the bytes and reports the path the host saved them at", async () => {
    const fetchImpl = okFetch();
    const outcome = await uploadPastedImage(png(), fetchImpl as unknown as typeof fetch);
    expect(outcome).toEqual({ ok: true, path: "/w/data/attachments/2026/08/a.png" });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(PASTE_IMAGE_ROUTE);
    expect(JSON.parse(String(init.body))).toEqual({ mimeType: "image/png", dataBase64: bytesToBase64(new Uint8Array(4)) });
  });

  // Refused HERE, before the upload: the host would reject it anyway, and the operator should
  // not wait on bytes that are going to be thrown away.
  it("refuses an oversized paste without calling the server", async () => {
    const fetchImpl = okFetch();
    const huge = { size: MAX_PASTE_IMAGE_BYTES + 1, type: "image/png", arrayBuffer: async () => new ArrayBuffer(0) } as unknown as File;
    expect(await uploadPastedImage(huge, fetchImpl as unknown as typeof fetch)).toEqual({ ok: false, reason: "too-large" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports a failure rather than a path when the host refuses, answers oddly, or is unreachable", async () => {
    const refused = vi.fn(async () => ({ ok: false, json: async () => ({}) }) as unknown as Response);
    expect(await uploadPastedImage(png(), refused as unknown as typeof fetch)).toEqual({ ok: false, reason: "upload-failed" });

    const pathless = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }) as unknown as Response);
    expect(await uploadPastedImage(png(), pathless as unknown as typeof fetch)).toEqual({ ok: false, reason: "upload-failed" });

    const offline = vi.fn(async () => {
      throw new Error("network down");
    });
    expect(await uploadPastedImage(png(), offline as unknown as typeof fetch)).toEqual({ ok: false, reason: "upload-failed" });
  });

  it("reports an unreadable clipboard file instead of posting an empty body", async () => {
    const fetchImpl = okFetch();
    const broken = {
      size: 10,
      type: "image/png",
      arrayBuffer: async () => {
        throw new Error("gone");
      },
    } as unknown as File;
    expect(await uploadPastedImage(broken, fetchImpl as unknown as typeof fetch)).toEqual({ ok: false, reason: "unreadable" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("pasteFailureLabel", () => {
  it("names every failure in the operator's language", () => {
    expect(pasteFailureLabel("too-large")).toContain("大き");
    expect(pasteFailureLabel("unreadable")).toContain("読め");
    expect(pasteFailureLabel("upload-failed")).toContain("失敗");
  });
});
