import { describe, it, expect } from "vitest";
import headless from "@xterm/headless";
import {
  appendBoundedOutput,
  appendReplayTail,
  foldPrivateModes,
  replayOf,
  replayPrefix,
  screenSourceOf,
  stripTerminalQueries,
} from "../../../server/session/terminal-replay.js";
import type { ReplayTail } from "../../../server/session/terminal-replay.js";

const { Terminal } = headless;

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);

describe("stripTerminalQueries", () => {
  it("removes a Device Attributes query embedded in output (the 0;276;0c symptom source)", () => {
    expect(stripTerminalQueries(`abc${ESC}[>c def`)).toBe("abc def");
    expect(stripTerminalQueries(`${ESC}[c`)).toBe("");
    expect(stripTerminalQueries(`${ESC}[>0c`)).toBe("");
  });

  it("removes device/cursor status queries", () => {
    expect(stripTerminalQueries(`${ESC}[6n`)).toBe("");
    expect(stripTerminalQueries(`x${ESC}[5ny`)).toBe("xy");
    expect(stripTerminalQueries(`${ESC}[?6n`)).toBe("");
  });

  it("removes kitty-keyboard and XTVERSION queries", () => {
    expect(stripTerminalQueries(`${ESC}[?u`)).toBe("");
    expect(stripTerminalQueries(`${ESC}[>q`)).toBe("");
    expect(stripTerminalQueries(`${ESC}[>0q`)).toBe("");
  });

  it("removes OSC color queries (BEL- or ST-terminated)", () => {
    expect(stripTerminalQueries(`${ESC}]10;?${BEL}`)).toBe("");
    expect(stripTerminalQueries(`${ESC}]11;?${ESC}\\`)).toBe("");
  });

  // A replayed OSC 52 re-executes a COPY: reload / sleep-wake / reattach would overwrite
  // the operator's current clipboard with whatever was copied when the buffer was written.
  it("removes OSC 52 clipboard writes (BEL- or ST-terminated), keeping surrounding text", () => {
    const payload = "QUJDRA".repeat(500); // kilobyte payloads are the designed-for case
    expect(stripTerminalQueries(`before${ESC}]52;c;${payload}${BEL}after`)).toBe("beforeafter");
    expect(stripTerminalQueries(`before${ESC}]52;c;${payload}${ESC}\\after`)).toBe("beforeafter");
    expect(stripTerminalQueries(`${ESC}]52;c;?${BEL}`)).toBe(""); // the query form is a paste-read — strip it too
  });

  it("does NOT strip a DA RESPONSE (multi-param) — only queries", () => {
    const response = `${ESC}[>0;276;0c`;
    expect(stripTerminalQueries(response)).toBe(response);
  });

  it("leaves visible text and SGR colour sequences untouched", () => {
    const styled = `${ESC}[31mhello${ESC}[0m world`;
    expect(stripTerminalQueries(styled)).toBe(styled);
    expect(stripTerminalQueries("plain text")).toBe("plain text");
  });
});

describe("appendBoundedOutput", () => {
  it("appends verbatim while under the limit", () => {
    expect(appendBoundedOutput("abc", "def", 100)).toBe("abcdef");
    expect(appendBoundedOutput("", "", 100)).toBe("");
  });

  it("keeps the tail once the limit is exceeded", () => {
    // Exactly at the limit is still verbatim — only a genuine overflow trims.
    expect(appendBoundedOutput("abcde", "", 5)).toBe("abcde");
    expect(appendBoundedOutput("abc\ndef", "ghi", 6)).toBe("defghi");
  });

  // The #434 regression: a cut inside an SGR left "5;196m" rendering as literal text.
  // Worst case — the tail has no newline and no later ESC to resume from.
  it("drops a leading sequence remnant when there is no boundary to resume from", () => {
    const stream = "x".repeat(50) + `${ESC}[38;5;196m` + "RED";
    expect(appendBoundedOutput(stream, "", 9)).toBe("RED"); // was "5;196mRED"
  });

  // A clean cut must keep EVERY retained byte. An earlier version resumed at the next
  // newline or ESC, silently discarding the head of the tail even when nothing was split.
  it("keeps the whole tail when the cut falls between sequences", () => {
    expect(appendBoundedOutput("zzzhello world", "", 11)).toBe("hello world");
    expect(appendBoundedOutput("y".repeat(200), "", 10)).toBe("y".repeat(10));
    // Including a leading newline: it is a real byte of the retained tail, not a boundary
    // to skip past.
    expect(appendBoundedOutput(`aaa\nbbb${ESC}[0m`, "", 8)).toBe(`\nbbb${ESC}[0m`);
  });

  // Codex's counter-examples against the previous heuristic, which pattern-matched the
  // head of the tail and ate ordinary punctuation-then-letter prefixes.
  it.each([
    ["5 files pending", 15],
    ["/api/v1/resource", 16],
    ["3.14 is pi", 10],
    [";not a sequence", 15],
  ])("does not touch plain text that merely looks like a sequence: %s", (text, limit) => {
    expect(appendBoundedOutput(`${"q".repeat(40)}${text}`, "", limit)).toBe(text);
  });

  it("drops only the split sequence, keeping the text that follows it", () => {
    // The cut lands inside the SGR; "RED" after it must survive intact.
    const stream = `${"x".repeat(50)}${ESC}[38;5;196mRED`;
    expect(appendBoundedOutput(stream, "", 12)).toBe("RED");
  });

  it("drops the introducer too when only the ESC was discarded", () => {
    const stream = `${"x".repeat(50)}${ESC}[31mbbb`;
    expect(appendBoundedOutput(stream, "", 7)).toBe("bbb");
  });

  it("keeps a sequence that closed before the cut", () => {
    const stream = `${"x".repeat(50)}${ESC}[31mvisible text`;
    expect(appendBoundedOutput(stream, "", 12)).toBe("visible text");
  });

  // An OSC string ends with BEL, not a CSI final byte, so scanning for 0x40-0x7E would
  // stop inside the title and leave half of it on screen.
  it("drops a split OSC string up to its BEL terminator", () => {
    const stream = `${"x".repeat(50)}${ESC}]0;window title${BEL}after`;
    expect(appendBoundedOutput(stream, "", 12)).toBe("after");
  });

  // ST is the two bytes `ESC \`. Consuming only the ESC leaks a stray backslash.
  it("drops a split OSC string up to its ST terminator, backslash included", () => {
    const stream = `${"x".repeat(50)}${ESC}]0;window title${ESC}\\after`;
    const out = appendBoundedOutput(stream, "", 12);
    expect(out.startsWith("\\")).toBe(false);
    expect(out).toBe("after");
  });

  it("keeps an OSC string that closed with ST before the cut", () => {
    const stream = `${"x".repeat(50)}${ESC}]0;title${ESC}\\visible text`;
    expect(appendBoundedOutput(stream, "", 12)).toBe("visible text");
  });

  // OSC 52 carries the clipboard as base64 and this host enables it deliberately
  // (infra/tmux.ts forwards Claude Code's auto-copy), so payloads run to kilobytes.
  // Any fixed look-behind window loses the introducer and leaks base64 onto the screen.
  it("finds the introducer of an OSC payload far longer than any fixed window", () => {
    const payload = "QUJDRA".repeat(500);
    const stream = `${"x".repeat(50)}${ESC}]52;c;${payload}${BEL}after`;
    expect(appendBoundedOutput(stream, "", 12)).toBe("after");
  });

  it("keeps a long OSC payload that closed before the cut", () => {
    const stream = `${"x".repeat(50)}${ESC}]52;c;${"QUJDRA".repeat(500)}${BEL}visible text`;
    expect(appendBoundedOutput(stream, "", 12)).toBe("visible text");
  });

  it("drops a split two-character sequence", () => {
    const stream = `${"x".repeat(50)}${ESC}Mrest`;
    expect(appendBoundedOutput(stream, "", 5)).toBe("rest");
  });

  it("stays within the limit", () => {
    const stream = `${"z".repeat(500)}\n${"w".repeat(500)}`;
    expect(appendBoundedOutput(stream, "more", 64).length).toBeLessThanOrEqual(64);
  });
});

describe("replay head modes", () => {
  const tail = (text: string, headModes: number[] = []): ReplayTail => ({ text, headModes: new Set(headModes) });

  it("folds only the DROPPED bytes: a mode set inside the retained tail is not a head mode", () => {
    const out = appendReplayTail(tail(""), `${ESC}[?2004h${"x".repeat(20)}${ESC}[?1000h`, 12);
    expect(out.headModes).toEqual(new Set([2004]));
    expect(out.text).toBe(`${"x".repeat(4)}${ESC}[?1000h`);
  });

  it("keeps nothing while under the limit", () => {
    const out = appendReplayTail(tail(""), `${ESC}[?1049h hi`, 100);
    expect(out.headModes.size).toBe(0);
    expect(out.text).toBe(`${ESC}[?1049h hi`);
  });

  it("a reset that also scrolled out cancels the set", () => {
    expect(foldPrivateModes(new Set(), `${ESC}[?1000h${ESC}[?1000l`)).toEqual(new Set());
    expect(foldPrivateModes(new Set([25]), `${ESC}[?25l`)).toEqual(new Set());
  });

  it("reads every parameter of a combined SET, and the leading number of a colon sub-parameter", () => {
    expect(foldPrivateModes(new Set(), `${ESC}[?1000;1006h${ESC}[?2026:1h`)).toEqual(new Set([1000, 1006, 2026]));
  });

  it("accumulates across appends, so a mode set long before the window is still known", () => {
    let t = appendReplayTail(tail(""), `${ESC}[?1049h${ESC}[?1h`, 8);
    for (let i = 0; i < 50; i++) t = appendReplayTail(t, `${ESC}[K${i}\r\n`, 8);
    expect(t.headModes).toEqual(new Set([1049, 1]));
    expect(t.text.length).toBeLessThanOrEqual(8);
  });

  it("emits one sequence per mode with the alternate screen first, mouse modes unbundled", () => {
    expect(replayPrefix(new Set([1000, 2004, 1049]))).toBe(`${ESC}[?1049h${ESC}[?1000h${ESC}[?2004h`);
    expect(replayPrefix(new Set())).toBe("");
  });

  it("replayOf strips queries from the tail but not the re-asserted modes", () => {
    expect(replayOf(tail(`a${ESC}[cb`, [1049]))).toBe(`${ESC}[?1049hab`);
    expect(screenSourceOf(tail(`a${ESC}[cb`, [1049]))).toBe(`${ESC}[?1049ha${ESC}[cb`);
  });

  // The failure as a terminal sees it. A tmux attach (captured from tmux 3.6a) opens the
  // alternate screen and mouse tracking, then repaints in place forever. Once the tail
  // window has slid past the attach, a replay must still land the emulator in the
  // alternate buffer with mouse tracking on — that is the state the wheel handler gates on.
  it("a replay whose window slid past the tmux attach still lands xterm in the alternate buffer", async () => {
    const attach = `${ESC}[?1049h${ESC}[22;0;0t${ESC}[?1h${ESC}=${ESC}[H${ESC}[2J${ESC}[?2004h${ESC}[?1006h${ESC}[?1000h${ESC}[?1002h`;
    const frame = (n: number) => `${ESC}[1;1H${ESC}[Kframe ${n}${ESC}[2;1H${ESC}[Kstill here`;
    const limit = 200;
    let t = appendReplayTail(tail(""), attach, limit);
    for (let i = 0; i < 30; i++) t = appendReplayTail(t, frame(i), limit);
    expect(t.text).not.toContain("1049h");

    const before = new Terminal({ cols: 40, rows: 5, allowProposedApi: true });
    await new Promise<void>((r) => before.write(stripTerminalQueries(t.text), r));
    expect(before.buffer.active.type).toBe("normal"); // the bug: nothing to scroll, nothing reported

    const after = new Terminal({ cols: 40, rows: 5, allowProposedApi: true });
    await new Promise<void>((r) => after.write(replayOf(t), r));
    expect(after.buffer.active.type).toBe("alternate");
    expect(after.modes.mouseTrackingMode).toBe("drag");
    expect(after.modes.bracketedPasteMode).toBe(true);
    expect(after.modes.applicationCursorKeysMode).toBe(true);
    expect(after.buffer.active.getLine(0)?.translateToString(true)).toBe("frame 29");
    before.dispose();
    after.dispose();
  });
});
