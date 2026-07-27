// The dev-channels consent auto-confirm (channel-consent.ts) exists to press one Enter,
// once, for one exact channel list the operator declared their own. Everything here pins
// the "narrow" part: no env opt-in means no scanner, a different channel list means no
// Enter, and the prompt arriving split across chunks still fires exactly once.
import { describe, it, expect, vi, afterEach } from "vitest";
import { attachChannelConsentAutoConfirm, consentPromptVisible, withChannelConsent } from "../../server/session/channel-consent";
import type { PtyEntry } from "../../server/session/types";

const PROMPT = ["WARNING: Loading development channels", "Channels: server:claude-peers", "1. I am using this for local development", "2. Exit"].join("\n");

function fakeEntry() {
  const writes: string[] = [];
  const entry = { term: { write: (data: string) => writes.push(data) } } as unknown as PtyEntry;
  return { entry, writes };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("consentPromptVisible", () => {
  it("needs both the prompt sentence and the wanted channel list", () => {
    expect(consentPromptVisible(PROMPT, "server:claude-peers")).toBe(true);
    expect(consentPromptVisible(PROMPT, "server:other-channel")).toBe(false);
    expect(consentPromptVisible("Channels: server:claude-peers", "server:claude-peers")).toBe(false);
  });

  it("matches through claude's real word-by-word SGR styling (tmux re-render)", () => {
    // Captured from a live spawn (tmux capture-pane -e): every WORD of the sentence is
    // wrapped in its own color pair, so a contiguous-substring match on the raw stream
    // never fires — this case is the regression that shipped first.
    const styled =
      "Channels: server:claude-peers\n" +
      "\x1b[38;5;153m❯\x1b[39m \x1b[38;5;246m1.\x1b[39m \x1b[38;5;153mI\x1b[39m \x1b[38;5;153mam\x1b[39m " +
      "\x1b[38;5;153musing\x1b[39m \x1b[38;5;153mthis\x1b[39m \x1b[38;5;153mfor\x1b[39m \x1b[38;5;153mlocal\x1b[39m " +
      "\x1b[38;5;153mdevelopment\x1b[39m";
    expect(consentPromptVisible(styled, "server:claude-peers")).toBe(true);
  });

  it("matches through claude's live layout — words placed by cursor-column moves, no spaces", () => {
    // Captured from a node-pty probe of the real binary: there are NO literal spaces
    // between words, each word is positioned with ESC[<col>G. An escape-strip that
    // replaces with "" (not " ") jams the words together and never matches.
    const live =
      "\x1b[3G\x1b[38;2;153;153;153mChannels:\x1b[13Gserver:claude-peers\x1b[39m\r\r\n" +
      "\x1b[3G\x1b[38;2;153;204;255m❯\x1b[5G\x1b[38;2;153;153;153m1.\x1b[8G\x1b[38;2;153;204;255mI\x1b[10Gam" +
      "\x1b[13Gusing\x1b[19Gthis\x1b[24Gfor\x1b[28Glocal\x1b[34Gdevelopment\x1b[39m\r\r\n";
    expect(consentPromptVisible(live, "server:claude-peers")).toBe(true);
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
    const scan = attachChannelConsentAutoConfirm(entry, { MULMOTERMINAL_AUTOCONFIRM_CHANNELS: "server:claude-peers" });
    const mid = Math.floor(PROMPT.length / 2);
    scan(PROMPT.slice(0, mid));
    scan(PROMPT.slice(mid));
    // A redraw of the same prompt must not queue a second Enter.
    scan(PROMPT);
    vi.runAllTimers();
    expect(writes).toEqual(["\r"]);
  });

  it("withChannelConsent still forwards every chunk to the wrapped scanner", () => {
    vi.useFakeTimers();
    const { entry, writes } = fakeEntry();
    const forwarded: string[] = [];
    const scan = withChannelConsent(entry, (data) => forwarded.push(data), { MULMOTERMINAL_AUTOCONFIRM_CHANNELS: "server:claude-peers" });
    scan(PROMPT);
    scan("later output");
    vi.runAllTimers();
    expect(writes).toEqual(["\r"]);
    expect(forwarded).toEqual([PROMPT, "later output"]);
  });

  it("leaves a session with a different channel list waiting for a human", () => {
    vi.useFakeTimers();
    const { entry, writes } = fakeEntry();
    const scan = attachChannelConsentAutoConfirm(entry, { MULMOTERMINAL_AUTOCONFIRM_CHANNELS: "server:claude-peers" });
    scan(PROMPT.replace("server:claude-peers", "server:something-else"));
    vi.runAllTimers();
    expect(writes).toEqual([]);
  });
});
