// The one place in the UI that touches navigator.clipboard for a WRITE, so every copy path
// (OSC 52 from the agent, copy-on-select, the cell's copy buttons) fails the same way and
// callers can tell success from failure instead of assuming it worked.
//
// The Clipboard API is absent on insecure origins (a LAN IP is not localhost) and in some
// webviews, and writeText rejects when the document isn't focused or permission is denied.
// None of that is exceptional here — it is "the copy didn't happen", which the caller shows
// on the button rather than throwing.
export async function writeSystemClipboard(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    if (!navigator.clipboard?.writeText) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
