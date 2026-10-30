// The workspace-trust auto-confirm (trust-consent.ts) answers "Yes, I trust this folder"
// once, for a cwd under the roots the operator declared their own — and is inert otherwise.
// Pinned here: no env → no scanner; cwd outside the roots → no keys; prose about the prompt
// (no rows / no key hint) → no keys; the cursor position decides Enter vs Down+Enter; the
// TUI painting or the arm window lapsing disarms it for good.
import { describe, it, expect, vi, afterEach } from "vitest";
import { attachTrustAutoConfirm, autoTrustAllowed, trustCursorOnYes, trustPromptVisible, withTrustConsent } from "../../../server/session/trust-consent";
import type { PtyEntry } from "../../../server/session/types";

const ROOTS = "/Users/me/Projects:/Users/me/Obsidian";
const ENV = { MULMOTERMINAL_AUTOTRUST_ROOTS: ROOTS };
const ident = (p: string) => p;

const PROMPT_NO_FIRST = [
  " Accessing workspace:",
  " /Users/me/Projects/大阪玩具/大阪玩具_Bカート",
  " Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team). If not,",
  " take a moment to review what's in this folder first.",
  " Claude Code'll be able to read, edit, and execute files here.",
  " Security guide",
  " ❯ No, exit",
  "   Yes, I trust this folder",
  " Enter to confirm · Esc to cancel",
].join("\n");
const PROMPT_YES_FIRST = PROMPT_NO_FIRST.replace(" ❯ No, exit\n   Yes, I trust this folder", " ❯ Yes, I trust this folder\n   No, exit");

function fakeEntry() {
  const writes: string[] = [];
  const entry = { term: { write: (data: string) => writes.push(data) } } as unknown as PtyEntry;
  return { entry, writes };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("trustPromptVisible", () => {
  it("needs the question, both rows and the confirm hint together", () => {
    expect(trustPromptVisible(PROMPT_NO_FIRST)).toBe(true);
    expect(trustPromptVisible(PROMPT_YES_FIRST)).toBe(true);
    // Prose about the chooser (a doc, this spec, a code review) quotes the question and a
    // row, never the whole menu with its key hint.
    expect(trustPromptVisible("the 'Is this a project you created or one you trust' chooser with Yes, I trust this folder")).toBe(false);
    expect(trustPromptVisible("No, exit / Yes, I trust this folder")).toBe(false);
  });

  it("matches through word-by-word cursor placement (claude's live layout)", () => {
    const live =
      "\x1b[2G\x1b[38;2;153;153;153mQuick\x1b[8Gsafety\x1b[15Gcheck:\x1b[22GIs\x1b[25Gthis\x1b[30Ga\x1b[32Gproject\x1b[40Gyou\x1b[44Gcreated\x1b[52Gor\x1b[55Gone\x1b[59Gyou\x1b[63Gtrust?\x1b[39m\r\n" +
      "\x1b[2G\x1b[38;2;153;204;255m❯\x1b[4GNo,\x1b[8Gexit\x1b[39m\r\n" +
      "\x1b[4GYes,\x1b[9GI\x1b[11Gtrust\x1b[17Gthis\x1b[22Gfolder\r\n" +
      "\x1b[2GEnter\x1b[8Gto\x1b[11Gconfirm\x1b[19G·\x1b[21GEsc\x1b[25Gto\x1b[28Gcancel\r\n";
    expect(trustPromptVisible(live)).toBe(true);
    expect(trustCursorOnYes(live)).toBe(false);
  });
});

describe("trustCursorOnYes", () => {
  it("reads the cursor row", () => {
    expect(trustCursorOnYes(PROMPT_NO_FIRST)).toBe(false);
    expect(trustCursorOnYes(PROMPT_YES_FIRST)).toBe(true);
  });
});

describe("autoTrustAllowed", () => {
  it("allows only cwds under a declared root (realpath-compared)", () => {
    expect(autoTrustAllowed("/Users/me/Projects/orosy-v2", ROOTS, ident)).toBe(true);
    expect(autoTrustAllowed("/Users/me/Projects", ROOTS, ident)).toBe(true);
    expect(autoTrustAllowed("/Users/me/Projectsx/evil", ROOTS, ident)).toBe(false);
    expect(autoTrustAllowed("/Users/me/Downloads/stranger", ROOTS, ident)).toBe(false);
    expect(autoTrustAllowed("/opt/elsewhere/x", ROOTS, ident)).toBe(false);
    expect(autoTrustAllowed("/Users/me/Projects/x", undefined, ident)).toBe(false);
    expect(autoTrustAllowed("/Users/me/Projects/x", "relative/root", ident)).toBe(false);
    // A symlink under a root that resolves outside it is judged by where it really points.
    const resolver = (p: string) => (p === "/Users/me/Projects/link" ? "/Volumes/usb/foreign" : p);
    expect(autoTrustAllowed("/Users/me/Projects/link", ROOTS, resolver)).toBe(false);
  });
});

describe("attachTrustAutoConfirm", () => {
  it("is a no-op without the env opt-in or outside the roots", () => {
    vi.useFakeTimers();
    for (const [env, cwd] of [
      [{}, "/Users/me/Projects/x"],
      [ENV, "/Users/me/Downloads/x"],
    ] as const) {
      const { entry, writes } = fakeEntry();
      attachTrustAutoConfirm(entry, cwd, env)(PROMPT_NO_FIRST);
      vi.advanceTimersByTime(2_000);
      expect(writes).toEqual([]);
    }
  });

  it("sends Down then Enter when the cursor sits on No, exit — once", () => {
    vi.useFakeTimers();
    const { entry, writes } = fakeEntry();
    const scan = attachTrustAutoConfirm(entry, "/Users/me/Projects/x", ENV);
    scan(PROMPT_NO_FIRST);
    scan(PROMPT_NO_FIRST);
    vi.advanceTimersByTime(2_000);
    expect(writes).toEqual(["\x1b[B", "\r"]);
  });

  it("sends only Enter when the cursor already sits on Yes", () => {
    vi.useFakeTimers();
    const { entry, writes } = fakeEntry();
    attachTrustAutoConfirm(entry, "/Users/me/Projects/x", ENV)(PROMPT_YES_FIRST);
    vi.advanceTimersByTime(2_000);
    expect(writes).toEqual(["\r"]);
  });

  it("disarms once the TUI has painted, and after the arm window", () => {
    vi.useFakeTimers();
    const painted = fakeEntry();
    const scan = attachTrustAutoConfirm(painted.entry, "/Users/me/Projects/x", ENV);
    scan("⏵⏵ auto mode on (shift+tab to cycle)");
    scan(PROMPT_NO_FIRST);
    vi.advanceTimersByTime(2_000);
    expect(painted.writes).toEqual([]);

    const late = fakeEntry();
    const scan2 = attachTrustAutoConfirm(late.entry, "/Users/me/Projects/x", ENV);
    vi.advanceTimersByTime(31_000);
    scan2(PROMPT_NO_FIRST);
    vi.advanceTimersByTime(2_000);
    expect(late.writes).toEqual([]);
  });

  it("withTrustConsent still feeds the wrapped scanner every chunk", () => {
    vi.useFakeTimers();
    const { entry } = fakeEntry();
    const seen: string[] = [];
    const scan = withTrustConsent(entry, "/Users/me/Projects/x", (d) => seen.push(d), ENV);
    scan("a");
    scan(PROMPT_NO_FIRST);
    expect(seen).toEqual(["a", PROMPT_NO_FIRST]);
  });
});
