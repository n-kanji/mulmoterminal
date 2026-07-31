import { describe, it, expect } from "vitest";
import { restorePreset, takePresetUndo, PRESET_UNDO_MS } from "../../../src/components/presetUndo";
import type { CwdPreset } from "../../../src/components/presets";

const LIST: CwdPreset[] = [
  { label: "orosy", path: "/w/orosy" },
  { label: "mulmo", path: "/w/mulmo" },
  { label: "docs", path: "/w/docs" },
];

describe("takePresetUndo", () => {
  it("remembers the entry AND the slot it came out of", () => {
    expect(takePresetUndo(LIST, "/w/mulmo")).toEqual({ preset: { label: "mulmo", path: "/w/mulmo" }, index: 1 });
  });

  it("offers nothing for a path the list never had", () => {
    expect(takePresetUndo(LIST, "/w/gone")).toBeNull();
    expect(takePresetUndo([], "/w/orosy")).toBeNull();
  });
});

describe("restorePreset", () => {
  // The whole point of remembering the index: the chip strip is hand-ordered (drag to
  // reorder), so re-adding at the front would undo the removal and silently rearrange the row.
  it("puts the entry back where it was, not at the front", () => {
    const pending = takePresetUndo(LIST, "/w/mulmo");
    if (!pending) throw new Error("expected a pending undo");
    const after = LIST.filter((p) => p.path !== "/w/mulmo");
    expect(restorePreset(after, pending).map((p) => p.path)).toEqual(["/w/orosy", "/w/mulmo", "/w/docs"]);
  });

  it("restores a removed FIRST and LAST chip to their own ends", () => {
    const first = takePresetUndo(LIST, "/w/orosy");
    const last = takePresetUndo(LIST, "/w/docs");
    if (!first || !last) throw new Error("expected pending undos");
    expect(restorePreset(LIST.slice(1), first).map((p) => p.path)).toEqual(["/w/orosy", "/w/mulmo", "/w/docs"]);
    expect(restorePreset(LIST.slice(0, 2), last).map((p) => p.path)).toEqual(["/w/orosy", "/w/mulmo", "/w/docs"]);
  });

  // A double-clicked undo, or a re-launch that re-recorded the dir before the operator got to
  // the undo, must not leave two chips for one directory.
  it("is a no-op when the path is already back in the list", () => {
    const pending = takePresetUndo(LIST, "/w/mulmo");
    if (!pending) throw new Error("expected a pending undo");
    expect(restorePreset(LIST, pending)).toEqual(LIST);
  });

  it("clamps an index the list has since outgrown", () => {
    const pending = { preset: { label: "docs", path: "/w/docs" }, index: 9 };
    expect(restorePreset([LIST[0]], pending).map((p) => p.path)).toEqual(["/w/orosy", "/w/docs"]);
  });

  it("never mutates the list it was given", () => {
    const pending = takePresetUndo(LIST, "/w/docs");
    if (!pending) throw new Error("expected a pending undo");
    const before = LIST.slice(0, 2);
    restorePreset(before, pending);
    expect(before).toHaveLength(2);
  });
});

// Long enough to notice a mis-click, short enough that the row is not left carrying a stale
// affordance — the only reader is the person still looking at the chip they just clicked.
describe("the undo window", () => {
  it("is five seconds", () => expect(PRESET_UNDO_MS).toBe(5000));
});
