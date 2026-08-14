import { describe, it, expect } from "vitest";
import { parseWebFontList } from "../../../src/composables/useWebFonts";

// hydrateWebFonts needs the real FontFace API (jsdom has none), so the spec pins the
// boundary rule instead: what off-the-wire shapes become registrations.
describe("parseWebFontList", () => {
  it("keeps well-formed entries and normalises style/weight to the two values @font-face gets", () => {
    expect(
      parseWebFontList({
        fonts: [
          { file: "A-Regular.woff2", family: "A", style: "normal", weight: 400 },
          { file: "A-BoldItalic.woff2", family: "A", style: "italic", weight: 700 },
          { file: "B.woff2", family: "B", style: "oblique", weight: 123 }, // out-of-vocab → regular
        ],
      }),
    ).toEqual([
      { file: "A-Regular.woff2", family: "A", style: "normal", weight: 400 },
      { file: "A-BoldItalic.woff2", family: "A", style: "italic", weight: 700 },
      { file: "B.woff2", family: "B", style: "normal", weight: 400 },
    ]);
  });

  it("drops malformed entries and answers empty for a malformed body", () => {
    expect(parseWebFontList({ fonts: [{ file: "", family: "A" }, { family: "A" }, { file: "x.woff2" }, "junk"] })).toEqual([]);
    expect(parseWebFontList(null)).toEqual([]);
    expect(parseWebFontList({})).toEqual([]);
    expect(parseWebFontList({ fonts: "nope" })).toEqual([]);
  });
});
