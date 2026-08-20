import { describe, it, expect, vi } from "vitest";

import { installMouseNavGuard, isNavButton } from "../../../src/composables/useMouseNavGuard";

// A minimal window double in the useFileDropGuard.spec.ts shape: records listeners so a
// test can fire them, and drops them on removeEventListener so teardown is observable.
function fakeTarget() {
  const listeners = new Map<string, EventListener>();
  return {
    addEventListener: (type: string, fn: EventListener) => listeners.set(type, fn),
    removeEventListener: (type: string, fn: EventListener) => {
      if (listeners.get(type) === fn) listeners.delete(type);
    },
    fire: (type: string, button: number) => {
      const preventDefault = vi.fn();
      listeners.get(type)?.({ button, preventDefault } as unknown as Event);
      return preventDefault;
    },
    has: (type: string) => listeners.has(type),
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
  it("prevents the default for the back/forward buttons on every navigation-capable event", () => {
    const target = fakeTarget();
    installMouseNavGuard(target);
    for (const type of ["mousedown", "mouseup", "auxclick"]) {
      expect(target.fire(type, 3)).toHaveBeenCalled();
      expect(target.fire(type, 4)).toHaveBeenCalled();
    }
  });

  it("leaves the main, middle and right buttons alone", () => {
    const target = fakeTarget();
    installMouseNavGuard(target);
    for (const type of ["mousedown", "mouseup", "auxclick"]) {
      for (const button of [0, 1, 2]) expect(target.fire(type, button)).not.toHaveBeenCalled();
    }
  });

  it("removes all listeners on teardown", () => {
    const target = fakeTarget();
    const uninstall = installMouseNavGuard(target);
    uninstall();
    for (const type of ["mousedown", "mouseup", "auxclick"]) expect(target.has(type)).toBe(false);
  });

  // The unit tests above assert preventDefault is CALLED; this drives the real window so the
  // browser-observable effect — a cancelled event, i.e. no history navigation — is verified.
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
});
