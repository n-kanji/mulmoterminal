import { describe, it, expect, vi } from "vitest";

import { installMouseNavGuard, isNavButton, NAV_BUTTON_EVENTS } from "../../../src/composables/useMouseNavGuard";

// A minimal window double in the useFileDropGuard.spec.ts shape: records listeners so a
// test can fire them, and drops them on removeEventListener so teardown is observable.
// It also records whether each listener was registered for the capture phase, which is
// the whole point of the guard (see the file header).
function fakeTarget() {
  const listeners = new Map<string, { fn: EventListener; capture: boolean }>();
  const captureOf = (opts: unknown) => (typeof opts === "object" && opts !== null ? Boolean((opts as AddEventListenerOptions).capture) : Boolean(opts));
  return {
    addEventListener: (type: string, fn: EventListener, opts?: unknown) => listeners.set(type, { fn, capture: captureOf(opts) }),
    removeEventListener: (type: string, fn: EventListener) => {
      if (listeners.get(type)?.fn === fn) listeners.delete(type);
    },
    fire: (type: string, button: number) => {
      const preventDefault = vi.fn();
      const stopImmediatePropagation = vi.fn();
      listeners.get(type)?.fn({ button, preventDefault, stopImmediatePropagation } as unknown as Event);
      return { preventDefault, stopImmediatePropagation };
    },
    has: (type: string) => listeners.has(type),
    isCapture: (type: string) => listeners.get(type)?.capture ?? false,
  };
}

describe("isNavButton", () => {
  it("matches exactly the browser back and forward buttons", () => {
    expect(isNavButton(3)).toBe(true);
    expect(isNavButton(4)).toBe(true);
    for (const other of [0, 1, 2, 5]) expect(isNavButton(other)).toBe(false);
  });
});

describe("installMouseNavGuard", () => {
  it("cancels AND stops the back/forward buttons on every event a press produces", () => {
    const target = fakeTarget();
    installMouseNavGuard(target);
    for (const type of NAV_BUTTON_EVENTS) {
      for (const button of [3, 4]) {
        const r = target.fire(type, button);
        expect(r.preventDefault).toHaveBeenCalled();
        expect(r.stopImmediatePropagation).toHaveBeenCalled();
      }
    }
  });

  it("listens in the capture phase, so it runs before xterm's own mousedown handler", () => {
    const target = fakeTarget();
    installMouseNavGuard(target);
    for (const type of NAV_BUTTON_EVENTS) expect(target.isCapture(type)).toBe(true);
  });

  it("leaves the main, middle and right buttons alone", () => {
    const target = fakeTarget();
    installMouseNavGuard(target);
    for (const type of NAV_BUTTON_EVENTS) {
      for (const button of [0, 1, 2]) {
        const r = target.fire(type, button);
        expect(r.preventDefault).not.toHaveBeenCalled();
        expect(r.stopImmediatePropagation).not.toHaveBeenCalled();
      }
    }
  });

  it("removes all listeners on teardown", () => {
    const target = fakeTarget();
    const uninstall = installMouseNavGuard(target);
    uninstall();
    for (const type of NAV_BUTTON_EVENTS) expect(target.has(type)).toBe(false);
  });

  // The unit tests above assert the calls are made; these drive the real DOM so the
  // browser-observable effects are verified: a cancelled event (no history navigation), and
  // an element-level listener — standing in for xterm's focus-on-mousedown — that never runs.
  it("cancels a real back-button event dispatched on window (so the browser won't navigate)", () => {
    const uninstall = installMouseNavGuard(window);
    const back = new MouseEvent("auxclick", { cancelable: true, bubbles: true, button: 3 });
    window.dispatchEvent(back);
    expect(back.defaultPrevented).toBe(true);

    const middle = new MouseEvent("auxclick", { cancelable: true, bubbles: true, button: 1 });
    window.dispatchEvent(middle);
    expect(middle.defaultPrevented).toBe(false);
    uninstall();
  });

  it("keeps a side-button mousedown from reaching an element's own listener (xterm's focus)", () => {
    const uninstall = installMouseNavGuard(window);
    const el = document.createElement("div");
    document.body.appendChild(el);
    const seen = vi.fn();
    el.addEventListener("mousedown", seen);

    el.dispatchEvent(new MouseEvent("mousedown", { cancelable: true, bubbles: true, button: 3 }));
    expect(seen).not.toHaveBeenCalled();

    el.dispatchEvent(new MouseEvent("mousedown", { cancelable: true, bubbles: true, button: 0 }));
    expect(seen).toHaveBeenCalledTimes(1);

    el.remove();
    uninstall();
  });
});
