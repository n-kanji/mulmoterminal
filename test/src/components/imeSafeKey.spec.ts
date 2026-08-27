import { describe, expect, it } from "vitest";
import { imeSafeKey, type RenameKeyEvent } from "../../../src/composables/imeSafeKey";

// The regression this pins (2026-08-27): typing a Japanese separator/pane/page name and
// pressing Enter to CONFIRM the IME conversion committed a stale draft and closed the
// editor — the rename silently vanished. The composition's own keystrokes must pass
// through the rename input untouched.

const event = (overrides: Partial<RenameKeyEvent> = {}) => {
  let prevented = false;
  return {
    e: {
      preventDefault: () => {
        prevented = true;
      },
      ...overrides,
    } satisfies RenameKeyEvent,
    wasPrevented: () => prevented,
  };
};

describe("imeSafeKey", () => {
  it("runs the action and prevents default on a plain keydown", () => {
    let ran = 0;
    const { e, wasPrevented } = event();
    imeSafeKey(() => ran++)(e);
    expect(ran).toBe(1);
    expect(wasPrevented()).toBe(true);
  });

  it("ignores the keydown that confirms an IME composition (isComposing)", () => {
    let ran = 0;
    const { e, wasPrevented } = event({ isComposing: true });
    imeSafeKey(() => ran++)(e);
    expect(ran).toBe(0);
    // The key belongs to the IME — default must not be prevented either.
    expect(wasPrevented()).toBe(false);
  });

  it("ignores the legacy keyCode 229 some browsers report during composition", () => {
    let ran = 0;
    const { e, wasPrevented } = event({ keyCode: 229 });
    imeSafeKey(() => ran++)(e);
    expect(ran).toBe(0);
    expect(wasPrevented()).toBe(false);
  });

  it("still runs when keyCode is present but not 229", () => {
    let ran = 0;
    const { e } = event({ keyCode: 13, isComposing: false });
    imeSafeKey(() => ran++)(e);
    expect(ran).toBe(1);
  });
});
