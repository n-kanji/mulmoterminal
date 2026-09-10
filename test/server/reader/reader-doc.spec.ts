// @vitest-environment node
// The pure half of the reader: what a brief's bytes mean, and the one rewrite the reader
// ever performs on them (the annotations-data block, nothing else).
import { describe, it, expect } from "vitest";
import {
  ANNOTATIONS_OPEN_TAG,
  countComments,
  docTitle,
  extractAnnotationsJson,
  injectReaderBridge,
  isBrief,
  replaceAnnotationsJson,
  validAnnotationsJson,
  assetContentType,
  READER_BRIDGE_SCRIPT,
} from "../../../server/reader/reader-doc.js";

const brief = (items: unknown[], extra = "") =>
  `<!doctype html><html><head><title>  Weekly &amp; brief </title></head><body class="x">${extra}<h1>Hi</h1>
<script type="application/json" id="annotations-data">${JSON.stringify({ items, savedAt: null })}</script>
</body></html>`;

describe("isBrief / docTitle", () => {
  it("recognises the data block and nothing else", () => {
    expect(isBrief(brief([]))).toBe(true);
    expect(isBrief("<html><body>plain</body></html>")).toBe(false);
  });
  it("reads the title, unescaped and trimmed, with a fallback", () => {
    expect(docTitle(brief([]), "fallback")).toBe("Weekly & brief");
    expect(docTitle("<html><title></title></html>", "fallback")).toBe("fallback");
    expect(docTitle("<html></html>", "fallback")).toBe("fallback");
  });
});

describe("countComments", () => {
  it("counts items and the ones not yet applied", () => {
    const html = brief([
      { id: 1, comment: "fix this" },
      { id: 2, comment: "done\n\n_(反映済み 2026-09-01)_" },
      { id: 3, type: "pin", comment: "here" },
    ]);
    expect(countComments(html)).toEqual({ comments: 3, open: 2 });
  });
  it("treats a broken block as no comments rather than failing the listing", () => {
    const html = brief([]).replace(/{"items":\[\],"savedAt":null}/, "{not json");
    expect(countComments(html)).toEqual({ comments: 0, open: 0 });
  });
});

describe("replaceAnnotationsJson", () => {
  it("rewrites only the block, and does not expand $-patterns from the comment text", () => {
    const html = brief([{ id: 1, comment: "old" }]);
    const json = JSON.stringify({ items: [{ id: 1, comment: "costs $1 and $11.38T" }] });
    const out = replaceAnnotationsJson(html, json) ?? "";
    expect(out).not.toBe("");
    expect(extractAnnotationsJson(out)).toBe(json);
    const strip = (page: string): string => page.replace(/<script type="application\/json" id="annotations-data">[^<]*<\/script>/, "X");
    expect(strip(out)).toBe(strip(html));
    expect(out).toContain(ANNOTATIONS_OPEN_TAG);
  });
  it("returns null for a page without a block", () => {
    expect(replaceAnnotationsJson("<html></html>", "{}")).toBeNull();
  });
});

describe("validAnnotationsJson", () => {
  it("accepts an object with items and refuses anything that would erase comments", () => {
    expect(validAnnotationsJson('{"items":[]}')).toBe(true);
    expect(validAnnotationsJson('{"items":[{"id":1}],"savedAt":"x"}')).toBe(true);
    expect(validAnnotationsJson("")).toBe(false);
    expect(validAnnotationsJson("null")).toBe(false);
    expect(validAnnotationsJson("[]")).toBe(false);
    expect(validAnnotationsJson('{"items":"no"}')).toBe(false);
  });
});

describe("injectReaderBridge", () => {
  it("puts the bridge right after <body ...>, before the page's own scripts", () => {
    const out = injectReaderBridge(brief([], "<script>window.first = true</script>"));
    const body = out.indexOf('<body class="x">');
    const bridge = out.indexOf('<script id="reader-bridge">');
    const first = out.indexOf("window.first");
    expect(body).toBeGreaterThan(-1);
    expect(bridge).toBeGreaterThan(body);
    expect(first).toBeGreaterThan(bridge);
  });
  it("falls back to before the first script, then to the top", () => {
    expect(injectReaderBridge("<div></div><script>1</script>")).toMatch(/^<div><\/div><script id="reader-bridge">/);
    expect(injectReaderBridge("<div></div>").startsWith(READER_BRIDGE_SCRIPT)).toBe(true);
  });
  it("the bridge stays inert outside an iframe", () => {
    expect(READER_BRIDGE_SCRIPT).toContain("if (window.parent === window) return;");
  });
});

describe("assetContentType", () => {
  it("serves images, styles and fonts, and nothing else", () => {
    expect(assetContentType(".PNG")).toBe("image/png");
    expect(assetContentType(".woff2")).toBe("font/woff2");
    expect(assetContentType(".exe")).toBeNull();
    expect(assetContentType(".html")).toBeNull();
  });
});
