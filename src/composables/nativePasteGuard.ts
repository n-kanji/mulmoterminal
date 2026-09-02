// Keep a paste OUT of xterm's hidden helper textarea.
//
// xterm handles a paste itself (Clipboard.ts `handlePasteEvent`: reads the clipboard, sends it
// to the PTY as a bracketed paste, empties the textarea) but only stops propagation — it never
// prevents the default, so the browser then inserts the same text into the textarea anyway.
// xterm clears that textarea only on blur or on an Enter it handled itself, so during one long
// prompt every pasted paragraph accumulates there.
//
// That residue is the ammunition for a duplicate-input bug (operator report 2026-09-02): the
// voice-input tool pastes with a synthesised Cmd+V, and when that lands while a Japanese IME
// composition is open, xterm's CompositionHelper treats the Cmd/V keydown as "composition
// over" and re-sends a textarea range computed from stale positions — which is the previously
// pasted paragraph, repeated, with the half-typed romaji ("…感じにｓ") force-committed between
// the copies. With the textarea kept empty there is nothing old to re-send.
//
// A CAPTURE-phase listener on the textarea runs before xterm's own (target/bubble) handler, and
// `preventDefault()` does not stop that handler from running — xterm still reads the clipboard
// and sends the text; only the browser's insertion into the textarea is suppressed.

export interface PasteGuardTarget {
  addEventListener(type: "paste", listener: (e: { preventDefault(): void }) => void, options?: boolean | AddEventListenerOptions): void;
}

// The listener itself, exported so a test can assert the one thing it does.
export const suppressNativePaste = (e: { preventDefault(): void }): void => {
  e.preventDefault();
};

export function guardNativePaste(textarea: PasteGuardTarget | null | undefined): void {
  if (!textarea) return; // a headless / not-yet-opened terminal has no textarea
  textarea.addEventListener("paste", suppressNativePaste, { capture: true });
}
