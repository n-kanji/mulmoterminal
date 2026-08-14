import { describe, it, expect } from "vitest";
import { fontFaceFromFilename, isServableFontFile } from "../../server/routes/fonts-routes.js";

describe("isServableFontFile", () => {
  it("accepts bare basenames in browser font formats, spaces and non-ASCII included", () => {
    expect(isServableFontFile("Anthropic Mono Web-Regular.woff2")).toBe(true);
    expect(isServableFontFile("HackGen35-Bold.ttf")).toBe(true);
    expect(isServableFontFile("源ノ角ゴシック.otf")).toBe(true);
  });

  it("refuses traversal, separators, hidden files, and non-font extensions", () => {
    expect(isServableFontFile("../secrets.woff2")).toBe(false);
    expect(isServableFontFile("a/b.woff2")).toBe(false);
    expect(isServableFontFile("a\\b.woff2")).toBe(false);
    expect(isServableFontFile(".hidden.woff2")).toBe(false);
    expect(isServableFontFile("font.svg")).toBe(false);
    expect(isServableFontFile("font.woff2.txt")).toBe(false);
  });
});

describe("fontFaceFromFilename", () => {
  it("derives family / style / weight from the foundry-convention suffix", () => {
    expect(fontFaceFromFilename("Anthropic Mono Web-Regular.woff2")).toEqual({
      file: "Anthropic Mono Web-Regular.woff2",
      family: "Anthropic Mono Web",
      style: "normal",
      weight: 400,
    });
    expect(fontFaceFromFilename("Foo-Italic.woff2")).toMatchObject({ family: "Foo", style: "italic", weight: 400 });
    expect(fontFaceFromFilename("Foo-Bold.ttf")).toMatchObject({ family: "Foo", style: "normal", weight: 700 });
    expect(fontFaceFromFilename("Foo-BoldItalic.otf")).toMatchObject({ family: "Foo", style: "italic", weight: 700 });
  });

  it("treats a suffix-less filename as the regular face of that family", () => {
    expect(fontFaceFromFilename("PlainMono.woff2")).toMatchObject({ family: "PlainMono", style: "normal", weight: 400 });
  });

  it("is null for anything isServableFontFile refuses, and for an empty family", () => {
    expect(fontFaceFromFilename("../x.woff2")).toBeNull();
    expect(fontFaceFromFilename("-Regular.woff2")).toBeNull();
  });
});
