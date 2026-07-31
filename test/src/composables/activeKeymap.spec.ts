import { describe, it, expect, beforeEach, vi } from "vitest";
import { computed } from "vue";
import { activeKeymap, getActiveKeymap, setActiveKeymap } from "../../../src/composables/activeKeymap.js";
import { keymapRows } from "../../../src/components/keymapLabels.js";
import { DEFAULT_KEYMAP } from "../../../common/keymap.js";

describe("activeKeymap", () => {
  beforeEach(() => setActiveKeymap(undefined));

  // R3: the defaults land when the CONFIG says so, not before. /api/config is async, and a user
  // whose config replaces these chords must not have them live during the fetch.
  it("starts empty, before /api/config has answered", async () => {
    vi.resetModules();
    const fresh = await import("../../../src/composables/activeKeymap.js");
    expect(fresh.getActiveKeymap()).toEqual({});
  });

  it("sanitizes what it is given, so a bad config.json can't reach the key handler", () => {
    setActiveKeymap({ "zoom-next": "PageDown", "warp-drive": "F1", "zoom-prev": "Shift+" });
    expect(getActiveKeymap()).toEqual({ "zoom-next": "PageDown" });
  });

  // R3 (fork-local). Upstream left an absent keymap empty; this fork ships the operator's
  // iTerm2 muscle memory instead, so a fresh install is keyboard-drivable out of the box.
  it("applies this fork's defaults when the config has no keymap", () => {
    setActiveKeymap(undefined);
    expect(getActiveKeymap()).toEqual(DEFAULT_KEYMAP);
    setActiveKeymap({});
    expect(getActiveKeymap()).toEqual(DEFAULT_KEYMAP);
  });

  // All-or-nothing, which is how upstream's reasoning survives: the user's one binding is not
  // silently joined by seven they never wrote and cannot see.
  it("applies NONE of the defaults once the config binds a single action", () => {
    setActiveKeymap({ "zoom-next": "PageDown" });
    expect(getActiveKeymap()).toEqual({ "zoom-next": "PageDown" });
  });

  it("falls back to the defaults again when the keymap goes away", () => {
    setActiveKeymap({ "zoom-next": "PageDown" });
    setActiveKeymap(undefined);
    expect(getActiveKeymap()).toEqual(DEFAULT_KEYMAP);
  });

  // Regression: /api/config is fetched asynchronously, so anything RENDERING the keymap must
  // see a late arrival. A snapshot taken before the fetch resolved would show every action as
  // unbound for as long as that screen stayed open.
  it("updates reactive consumers when the config arrives late", () => {
    const rows = computed(() => keymapRows(activeKeymap.value));
    // The defaults are what a config with no keymap leaves in force (the beforeEach) — a user
    // config that REPLACES them has to reach a screen already rendered from this.
    expect(rows.value.find((r) => r.action === "zoom-toggle")?.binding).toBe(DEFAULT_KEYMAP["zoom-toggle"]);

    setActiveKeymap({ "zoom-toggle": "F8" });

    const toggle = rows.value.find((r) => r.action === "zoom-toggle");
    expect(toggle?.binding).toBe("F8");
    // Everything else still reads as unbound, and is still listed.
    expect(rows.value.filter((r) => r.binding === null)).toHaveLength(rows.value.length - 1);
  });
});

describe("keymapRows", () => {
  it("lists EVERY action, bound or not — an unbound row is how the action is discovered", () => {
    const rows = keymapRows({ "zoom-next": "PageDown" });
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.every((r) => r.label.length > 0)).toBe(true);
    expect(rows.find((r) => r.action === "zoom-next")?.binding).toBe("PageDown");
    expect(rows.find((r) => r.action === "terminal-close")?.binding).toBeNull();
  });
});
