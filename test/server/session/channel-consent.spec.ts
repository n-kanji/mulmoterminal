// The dev-channels consent auto-confirm (channel-consent.ts) exists to press one Enter,
// once, for one exact channel list the operator declared their own — and to be INERT the
// rest of the session. Everything here pins the narrow part: no env opt-in means no
// scanner, a different channel list means no Enter, prose ABOUT the prompt (no Exit row)
// means no Enter, and once the TUI has painted or the arm window has lapsed the scanner
// is disarmed for good — viewing this very file from a spawned session must not fire it.
import { describe, it, expect, vi, afterEach } from "vitest";
import { attachChannelConsentAutoConfirm, consentPromptVisible, withChannelConsent } from "../../../server/session/channel-consent";
import type { PtyEntry } from "../../../server/session/types";

const ENV = { MULMOTERMINAL_AUTOCONFIRM_CHANNELS: "server:claude-peers" };

const PROMPT = ["WARNING: Loading development channels", "Channels: server:claude-peers", "❯ 1. I am using this for local development", "  2. Exit"].join("\n");

function fakeEntry() {
  const writes: string[] = [];
  const entry = { term: { write: (data: string) => writes.push(data) } } as unknown as PtyEntry;
  return { entry, writes };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("consentPromptVisible", () => {
  it("needs the sentence, the Exit row and the wanted channel list together", () => {
    expect(consentPromptVisible(PROMPT, "server:claude-peers")).toBe(true);
    expect(consentPromptVisible(PROMPT, "server:other-channel")).toBe(false);
    expect(consentPromptVisible("Channels: server:claude-peers", "server:claude-peers")).toBe(false);
    // Prose about the prompt — a doc or spec quoting the sentence and the channel name
    // but not the chooser menu — must not count as the chooser being on screen.
    expect(consentPromptVisible("the I am using this for local development chooser for server:claude-peers", "server:claude-peers")).toBe(false);
  });

  it("matches through claude's real word-by-word SGR styling (tmux re-render)", () => {
    // Captured from a live spawn (tmux capture-pane -e): every WORD of the sentence is
    // wrapped in its own color pair, so a contiguous-substring match on the raw stream
    // never fires — this case is the regression that shipped first.
    const styled =
      "Channels: server:claude-peers\n" +
      "\x1b[38;5;153m❯\x1b[39m \x1b[38;5;246m1.\x1b[39m \x1b[38;5;153mI\x1b[39m \x1b[38;5;153mam\x1b[39m " +
      "\x1b[38;5;153musing\x1b[39m \x1b[38;5;153mthis\x1b[39m \x1b[38;5;153mfor\x1b[39m \x1b[38;5;153mlocal\x1b[39m " +
      "\x1b[38;5;153mdevelopment\x1b[39m\n" +
      "  \x1b[38;5;246m2.\x1b[39m Exit";
    expect(consentPromptVisible(styled, "server:claude-peers")).toBe(true);
  });

  it("matches through claude's live layout — words placed by cursor-column moves, no spaces", () => {
    // Captured from a node-pty probe of the real binary: there are NO literal spaces
    // between words, each word is positioned with ESC[<col>G. An escape-strip that
    // replaces with "" (not " ") jams the words together and never matches.
    const live =
      "\x1b[3G\x1b[38;2;153;153;153mChannels:\x1b[13Gserver:claude-peers\x1b[39m\r\r\n" +
      "\x1b[3G\x1b[38;2;153;204;255m❯\x1b[5G\x1b[38;2;153;153;153m1.\x1b[8G\x1b[38;2;153;204;255mI\x1b[10Gam" +
      "\x1b[13Gusing\x1b[19Gthis\x1b[24Gfor\x1b[28Glocal\x1b[34Gdevelopment\x1b[39m\r\r\n" +
      "\x1b[5G\x1b[38;2;153;153;153m2.\x1b[8G\x1b[39mExit\r\r\n";
    expect(consentPromptVisible(live, "server:claude-peers")).toBe(true);
  });

  it("survives escapes the simple CSI/OSC pattern used to miss", () => {
    // tmux attribute reset (charset designation + SGR), colon-form SGR, a private-mode
    // CSI with an intermediate byte, a BEL-terminated OSC, and an OSC truncated at the
    // window edge — each previously left bytes that broke the match.
    const noisy =
      "Channels:\x1b(B\x1b[m server:claude-peers\n" +
      "❯ 1. I\x1b[38:2::153:153:153m am\x1b[?1000$p using\x1b7 this\x1b8 for\x1bM local\x1b= development\n" +
      "  2.\x1b]0;some-title\x07 Exit\x1b]0;truncated-at-the-window-edge";
    expect(consentPromptVisible(noisy, "server:claude-peers")).toBe(true);
  });
});

describe("attachChannelConsentAutoConfirm", () => {
  it("is a no-op without the env opt-in", () => {
    vi.useFakeTimers();
    const { entry, writes } = fakeEntry();
    const scan = attachChannelConsentAutoConfirm(entry, {});
    scan(PROMPT);
    vi.runAllTimers();
    expect(writes).toEqual([]);
  });

  it("sends one CR when the opted-in prompt paints, even split across chunks", () => {
    vi.useFakeTimers();
    const { entry, writes } = fakeEntry();
    const scan = attachChannelConsentAutoConfirm(entry, ENV);
    const mid = Math.floor(PROMPT.length / 2);
    scan(PROMPT.slice(0, mid));
    scan(PROMPT.slice(mid));
    // A redraw of the same prompt must not queue a second Enter.
    scan(PROMPT);
    vi.runAllTimers();
    expect(writes).toEqual(["\r"]);
  });

  it("leaves a session with a different channel list waiting for a human", () => {
    vi.useFakeTimers();
    const { entry, writes } = fakeEntry();
    const scan = attachChannelConsentAutoConfirm(entry, ENV);
    scan(PROMPT.replace(/server:claude-peers/g, "server:something-else"));
    vi.runAllTimers();
    expect(writes).toEqual([]);
  });

  it("disarms once the TUI readiness marker paints — later prompt-like output is ignored", () => {
    vi.useFakeTimers();
    const { entry, writes } = fakeEntry();
    const scan = attachChannelConsentAutoConfirm(entry, ENV);
    scan("⏵⏵ auto mode on (shift+tab to cycle)");
    // The session is now interactive; this is a user LOOKING AT the prompt text
    // (cat of a doc, a code review) — pressing Enter here would hit a live session.
    scan(PROMPT);
    vi.runAllTimers();
    expect(writes).toEqual([]);
  });

  it("disarms after the arm window even if the marker never paints", () => {
    vi.useFakeTimers();
    const { entry, writes } = fakeEntry();
    const scan = attachChannelConsentAutoConfirm(entry, ENV);
    vi.advanceTimersByTime(30_001);
    scan(PROMPT);
    vi.runAllTimers();
    expect(writes).toEqual([]);
  });

  it("withChannelConsent still forwards every chunk to the wrapped scanner", () => {
    vi.useFakeTimers();
    const { entry, writes } = fakeEntry();
    const forwarded: string[] = [];
    const scan = withChannelConsent(entry, (data) => forwarded.push(data), ENV);
    scan(PROMPT);
    scan("later output");
    vi.runAllTimers();
    expect(writes).toEqual(["\r"]);
    expect(forwarded).toEqual([PROMPT, "later output"]);
  });
});
