import { describe, it, expect } from "vitest";
import { gridShortcutFor, isEditableTarget, type ShortcutKeyEvent } from "../../../src/composables/gridShortcut.js";
import { DEFAULT_KEYMAP, keymapWithDefaults, type Keymap } from "../../../common/keymap.js";

const KEYMAP: Keymap = { "zoom-next": "PageDown", "zoom-prev": "PageUp" };

const key = (over: Partial<ShortcutKeyEvent> = {}): ShortcutKeyEvent => ({
  type: "keydown",
  key: "PageDown",
  shiftKey: false,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  ...over,
});

describe("gridShortcutFor", () => {
  it("resolves the user's bindings while zoomed", () => {
    expect(gridShortcutFor(KEYMAP, key({ key: "PageDown" }), true)).toBe("zoom-next");
    expect(gridShortcutFor(KEYMAP, key({ key: "PageUp" }), true)).toBe("zoom-prev");
  });

  it("does nothing with an EMPTY keymap — shortcuts are opt-in via config.json", () => {
    expect(gridShortcutFor({}, key({ key: "PageDown" }), true)).toBeNull();
    expect(gridShortcutFor({}, key({ key: "PageUp" }), true)).toBeNull();
  });

  it("does nothing when nothing is zoomed — an un-zoomed grid has no selected terminal", () => {
    expect(gridShortcutFor(KEYMAP, key({ key: "PageDown" }), false)).toBeNull();
    expect(gridShortcutFor(KEYMAP, key({ key: "PageUp" }), false)).toBeNull();
  });

  it("gates the actions that need a subject terminal on being zoomed", () => {
    const map: Keymap = { "terminal-new-adjacent": "F2", "terminal-close": "F3" };
    expect(gridShortcutFor(map, key({ key: "F2" }), true)).toBe("terminal-new-adjacent");
    expect(gridShortcutFor(map, key({ key: "F3" }), true)).toBe("terminal-close");
    expect(gridShortcutFor(map, key({ key: "F2" }), false)).toBeNull();
    expect(gridShortcutFor(map, key({ key: "F3" }), false)).toBeNull();
  });

  it("lets terminal-new work WITHOUT a zoom — appending a cell needs no subject", () => {
    const map: Keymap = { "terminal-new": "F1" };
    expect(gridShortcutFor(map, key({ key: "F1" }), false)).toBe("terminal-new");
    expect(gridShortcutFor(map, key({ key: "F1" }), true)).toBe("terminal-new");
  });

  it("leaves Shift+PageUp alone when only the bare key is bound (xterm's scrollback)", () => {
    expect(gridShortcutFor(KEYMAP, key({ key: "PageUp", shiftKey: true }), true)).toBeNull();
    expect(gridShortcutFor(KEYMAP, key({ key: "PageDown", shiftKey: true }), true)).toBeNull();
  });

  it("honours a binding that DOES ask for a modifier", () => {
    const shifted: Keymap = { "zoom-next": "Shift+PageDown" };
    expect(gridShortcutFor(shifted, key({ key: "PageDown", shiftKey: true }), true)).toBe("zoom-next");
    expect(gridShortcutFor(shifted, key({ key: "PageDown" }), true)).toBeNull();
  });

  it("leaves every other modifier combination alone", () => {
    expect(gridShortcutFor(KEYMAP, key({ altKey: true }), true)).toBeNull();
    expect(gridShortcutFor(KEYMAP, key({ ctrlKey: true }), true)).toBeNull();
    expect(gridShortcutFor(KEYMAP, key({ metaKey: true }), true)).toBeNull();
  });

  it("ignores anything that isn't a keydown", () => {
    expect(gridShortcutFor(KEYMAP, key({ type: "keyup" }), true)).toBeNull();
    expect(gridShortcutFor(KEYMAP, key({ type: "keypress" }), true)).toBeNull();
  });

  it("ignores the keystroke while an IME is composing — it pages the candidate list", () => {
    expect(gridShortcutFor(KEYMAP, key({ isComposing: true }), true)).toBeNull();
  });

  it("ignores unbound keys", () => {
    expect(gridShortcutFor(KEYMAP, key({ key: "ArrowDown" }), true)).toBeNull();
    expect(gridShortcutFor(KEYMAP, key({ key: "" }), true)).toBeNull();
  });

  // R3. The column and page actions are the plain grid's own — they act on the FOCUSED cell or
  // on the view, not on a zoomed terminal, so gating them on the zoom would make them dead in
  // the only place they mean anything.
  describe("column and page actions (R3)", () => {
    const DEFAULTS = keymapWithDefaults({});
    // macOS sends the Option-rewritten character; the binding matches on the physical key.
    const alt = (code: string, char: string) => key({ key: char, code, altKey: true });

    it("resolves the column moves UN-zoomed", () => {
      expect(gridShortcutFor(DEFAULTS, alt("KeyL", "¬"), false)).toBe("focus-next-column");
      expect(gridShortcutFor(DEFAULTS, alt("KeyJ", "∆"), false)).toBe("focus-prev-column");
    });

    it("resolves the page moves UN-zoomed", () => {
      expect(gridShortcutFor(DEFAULTS, alt("KeyH", "˙"), false)).toBe("page-next");
      expect(gridShortcutFor(DEFAULTS, alt("KeyU", "¨"), false)).toBe("page-prev");
    });

    it("resolves them zoomed as well — nothing here needs a zoom to be refused", () => {
      expect(gridShortcutFor(DEFAULTS, alt("KeyL", "¬"), true)).toBe("focus-next-column");
      expect(gridShortcutFor(DEFAULTS, alt("KeyH", "˙"), true)).toBe("page-next");
    });

    // The upstream gate is unchanged: these still need a terminal the grid can name.
    it("still refuses the zoom-only actions un-zoomed", () => {
      expect(gridShortcutFor(DEFAULTS, alt("KeyN", "˜"), false)).toBeNull(); // terminal-new-adjacent
      expect(gridShortcutFor(DEFAULTS, alt("KeyW", "∑"), false)).toBeNull(); // terminal-close
      expect(gridShortcutFor(DEFAULTS, alt("KeyN", "˜"), true)).toBe("terminal-new-adjacent");
      expect(gridShortcutFor(DEFAULTS, alt("KeyW", "∑"), true)).toBe("terminal-close");
    });

    it("lets the ways IN work un-zoomed, as they always did", () => {
      expect(gridShortcutFor(DEFAULTS, alt("KeyZ", "Ω"), false)).toBe("zoom-toggle");
      expect(gridShortcutFor(DEFAULTS, alt("KeyA", "å"), false)).toBe("next-attention");
    });

    it("leaves an Alt chord this fork does not bind to the terminal", () => {
      expect(DEFAULT_KEYMAP["terminal-new"]).toBeUndefined();
      expect(gridShortcutFor(DEFAULTS, alt("KeyS", "ß"), false)).toBeNull();
      expect(gridShortcutFor(DEFAULTS, alt("KeyT", "†"), true)).toBeNull();
    });

    it("still ignores a keyup and an IME composition on the new bindings", () => {
      expect(gridShortcutFor(DEFAULTS, { ...alt("KeyL", "¬"), type: "keyup" }, false)).toBeNull();
      expect(gridShortcutFor(DEFAULTS, { ...alt("KeyL", "¬"), isComposing: true }, false)).toBeNull();
    });
  });
});

describe("isEditableTarget", () => {
  it("treats form fields as editable", () => {
    expect(isEditableTarget("INPUT", [])).toBe(true);
    expect(isEditableTarget("TEXTAREA", [])).toBe(true);
    expect(isEditableTarget("SELECT", [])).toBe(true);
  });

  it("does NOT treat xterm's helper textarea as editable — the shortcut must work there", () => {
    expect(isEditableTarget("TEXTAREA", ["xterm-helper-textarea"])).toBe(false);
  });

  it("keeps other classes on a textarea editable", () => {
    expect(isEditableTarget("TEXTAREA", ["some-other-class"])).toBe(true);
  });

  it("is case-insensitive about the tag name", () => {
    expect(isEditableTarget("input", [])).toBe(true);
    expect(isEditableTarget("textarea", [])).toBe(true);
  });

  it("leaves non-form elements alone", () => {
    expect(isEditableTarget("DIV", [])).toBe(false);
    expect(isEditableTarget("BUTTON", [])).toBe(false);
    expect(isEditableTarget("", [])).toBe(false);
  });
});
