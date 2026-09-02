import { describe, it, expect, vi } from "vitest";
import { guardNativePaste, suppressNativePaste } from "../../../src/composables/nativePasteGuard";

// Why this exists: xterm sends a paste to the PTY itself but lets the browser ALSO insert the
// text into its hidden textarea, where it sits until blur/Enter. A voice-input paste (Cmd+V)
// landing mid-IME-composition then makes xterm re-send that residue as a duplicate paragraph.
// The guard's whole job is to stop the browser's insertion while leaving xterm's handler alone.
describe("guardNativePaste", () => {
  it("registers a CAPTURE-phase paste listener on the textarea", () => {
    const add = vi.fn();
    guardNativePaste({ addEventListener: add });
    expect(add).toHaveBeenCalledTimes(1);
    const [type, listener, options] = add.mock.calls[0];
    expect(type).toBe("paste");
    expect(listener).toBe(suppressNativePaste);
    // Capture is the point: it must run BEFORE xterm's own target-phase paste handler, which
    // calls stopPropagation — a bubble-phase listener would never fire.
    expect(options).toEqual({ capture: true });
  });

  it("the listener only prevents the default insertion — it does not stop propagation", () => {
    const e = { preventDefault: vi.fn(), stopPropagation: vi.fn(), stopImmediatePropagation: vi.fn() };
    suppressNativePaste(e);
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
    // xterm's handler must still run, or the paste would never reach the PTY at all.
    expect(e.stopPropagation).not.toHaveBeenCalled();
    expect(e.stopImmediatePropagation).not.toHaveBeenCalled();
  });

  it("tolerates a terminal with no textarea (headless / not opened yet)", () => {
    expect(() => guardNativePaste(null)).not.toThrow();
    expect(() => guardNativePaste(undefined)).not.toThrow();
  });
});
