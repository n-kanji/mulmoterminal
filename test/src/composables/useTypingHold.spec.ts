import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { effectScope } from "vue";
import { isTerminalTextarea, useTypingHold, TYPING_HOLD_MS, XTERM_TEXTAREA_CLASS } from "../../../src/composables/useTypingHold";

// The composable owns window listeners and a timer, so each test runs it inside its own scope
// and disposes it — a leaked capture-phase keydown listener would follow the suite around.
function withHold<T>(run: (hold: ReturnType<typeof useTypingHold>) => T): T {
  const scope = effectScope();
  const hold = scope.run(() => useTypingHold());
  if (!hold) throw new Error("scope did not run");
  try {
    return run(hold);
  } finally {
    scope.stop();
  }
}

function terminalTextarea(): HTMLTextAreaElement {
  const el = document.createElement("textarea");
  el.className = XTERM_TEXTAREA_CLASS;
  document.body.appendChild(el);
  return el;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("isTerminalTextarea", () => {
  it("is xterm's own hidden textarea and nothing else", () => {
    expect(isTerminalTextarea(terminalTextarea())).toBe(true);
    // The launch form's dir field and the page-rename box are inputs the operator types in
    // too, and neither is a terminal — holding the sort for them would freeze the grid for
    // reasons that have nothing to do with a pane.
    expect(isTerminalTextarea(document.createElement("input"))).toBe(false);
    expect(isTerminalTextarea(document.createElement("textarea"))).toBe(false);
    expect(isTerminalTextarea(null)).toBe(false);
  });
});

describe("useTypingHold", () => {
  it("holds from the first keystroke in a terminal", () => {
    withHold(({ holding, noteKeystroke }) => {
      expect(holding.value).toBe(false);
      noteKeystroke(terminalTextarea());
      expect(holding.value).toBe(true);
    });
  });

  it("releases two seconds after the LAST keystroke, not the first", () => {
    withHold(({ holding, noteKeystroke }) => {
      const el = terminalTextarea();
      noteKeystroke(el);
      vi.advanceTimersByTime(TYPING_HOLD_MS - 100);
      noteKeystroke(el); // still typing — the window restarts
      vi.advanceTimersByTime(TYPING_HOLD_MS - 100);
      expect(holding.value).toBe(true);
      vi.advanceTimersByTime(200);
      expect(holding.value).toBe(false);
    });
  });

  it("ignores typing anywhere that is not a terminal", () => {
    withHold(({ holding, noteKeystroke }) => {
      noteKeystroke(document.createElement("input"));
      expect(holding.value).toBe(false);
    });
  });

  // The other way out: nothing is being typed anywhere, so there is nothing left to protect
  // and the columns should settle immediately rather than after a dead two seconds.
  it("releases at once when the terminal loses focus", () => {
    withHold(({ holding }) => {
      const el = terminalTextarea();
      el.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
      expect(holding.value).toBe(true);
      el.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      expect(holding.value).toBe(false);
    });
  });

  it("listens on the window, so it sees keys xterm handles itself", () => {
    withHold(({ holding }) => {
      terminalTextarea().dispatchEvent(new KeyboardEvent("keydown", { key: "x", bubbles: true }));
      expect(holding.value).toBe(true);
    });
  });

  it("stops listening once its scope is disposed", () => {
    const el = terminalTextarea();
    const hold = withHold((h) => h); // disposed on the way out
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    expect(hold.holding.value).toBe(false);
  });
});
