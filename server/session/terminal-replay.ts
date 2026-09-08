// Terminal "query" control sequences an application writes to probe the emulator — Device
// Attributes, device/cursor status, OSC color, kitty-keyboard flags, XTVERSION. The emulator
// auto-REPLIES to each. That's correct live, but when we replay a reattached session's buffered
// output, xterm re-answers the queries baked into it and the stale replies are sent back as
// INPUT, surfacing as junk like "0;276;0c" in the app's prompt (codex writes several at startup).
// Strip them from the replay only: they render nothing, so the visual restore is unchanged, and
// the app re-queries live if it still needs to.
//
// Built via new RegExp so the ESC/BEL control chars stay out of the regex source (satisfies
// no-control-regex without a disable).
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);

const QUERY_PATTERNS: RegExp[] = [
  new RegExp(ESC + "\\[[>=]?\\d*c", "g"), // Device Attributes (DA1/DA2/DA3) — the "…c" symptom
  new RegExp(ESC + "\\[\\??\\d*n", "g"), // device / cursor status report (DSR / CPR)
  new RegExp(ESC + "\\[\\?u", "g"), // kitty keyboard flags query
  new RegExp(ESC + "\\[>\\d*q", "g"), // XTVERSION
  new RegExp(ESC + "\\]1[012];\\?(?:" + BEL + "|" + ESC + "\\\\)", "g"), // OSC 10/11/12 fg/bg/cursor color query
  // OSC 52 clipboard writes. Not a query, but the same replay hazard with a worse blast
  // radius: this host enables OSC 52 on purpose (infra/tmux.ts), so a copy that happened
  // HOURS ago sits in the buffer, and replaying it on reload / sleep-wake / reattach
  // silently overwrites whatever the operator has on the system clipboard right now.
  // A copy is an event, not screen state — replay restores the screen, so it renders
  // nothing and loses nothing by dropping these. Live output is untouched.
  new RegExp(ESC + "\\]52;[^\\x07\\x1b]*(?:" + BEL + "|" + ESC + "\\\\)", "g"),
];

export function stripTerminalQueries(data: string): string {
  return QUERY_PATTERNS.reduce((out, re) => out.replace(re, ""), data);
}

// A CSI sequence closes with a final byte in 0x40-0x7E; an OSC string closes with BEL
// or ST. Neither can appear inside the sequence before its terminator, so the first
// occurrence IS the end.
const CSI_FINAL = /[\x40-\x7E]/;
// ST is the TWO bytes `ESC \`, so the backslash must be consumed with the escape or it
// leaks into the retained output. The trailing `?` still matches a lone ESC, which is
// how a terminal aborts an unfinished OSC.
const OSC_TERMINATOR = new RegExp(BEL + "|" + ESC + "\\\\?");

// Past the END of the terminator, not past its first character — ST is two bytes wide.
const firstMatchEnd = (text: string, terminator: RegExp): number => {
  const found = terminator.exec(text);
  if (!found) return text.length;
  return found.index + found[0].length;
};

// How many leading characters of `cut` belong to a sequence the truncation split. Zero
// when the cut fell cleanly BETWEEN sequences — the common case, and the one where every
// byte must be kept.
//
// This is decided from the discarded side, not guessed from the retained side. An earlier
// version pattern-matched the head of `cut` and could strip ordinary text
// ("/api/v1/resource" -> "pi/v1/resource"); knowing what was thrown away removes the
// guesswork entirely.
//
// The search for the opening escape spans the WHOLE discarded prefix rather than a fixed
// window. A bounded look-behind misses OSC strings whose payload is longer than the
// window — and this host enables OSC 52 deliberately (see infra/tmux.ts), so kilobyte
// base64 clipboard payloads are a designed-for case, not a hypothetical.
const splitSequenceLength = (combined: string, cutAt: number, cut: string): number => {
  const escapeAt = combined.lastIndexOf(ESC, cutAt - 1);
  if (escapeAt === -1) return 0;
  const afterEscape = combined.slice(escapeAt + 1, cutAt);
  // The introducer went with the discarded text, or it is the first retained character.
  const introducer = afterEscape.length > 0 ? afterEscape.charAt(0) : cut.charAt(0);
  const retained = afterEscape.length > 0 ? cut : cut.slice(1);
  const consumedIntroducer = afterEscape.length > 0 ? 0 : 1;
  if (introducer === "[") {
    // Closed already if a final byte followed the introducer before the cut.
    if (CSI_FINAL.test(afterEscape.slice(1))) return 0;
    return consumedIntroducer + firstMatchEnd(retained, CSI_FINAL);
  }
  if (introducer === "]") {
    if (OSC_TERMINATOR.test(afterEscape.slice(1))) return 0;
    return consumedIntroducer + firstMatchEnd(retained, OSC_TERMINATOR);
  }
  // A two-character sequence (ESC + one byte). It is complete unless that byte is the
  // first retained character, in which case dropping it alone is enough.
  return consumedIntroducer;
};

// Append PTY output, keeping a bounded tail for reattach replay.
//
// Cutting by character count can land INSIDE an escape sequence, and the orphaned
// parameter bytes then render as literal junk ("5;196m") at the top of the screen
// restored on reattach — stripTerminalQueries can't help, it only matches whole
// sequences. So drop exactly the split sequence and nothing else.
export function appendBoundedOutput(buffer: string, data: string, limit: number): string {
  const combined = buffer + data;
  if (combined.length <= limit) return combined;
  const cutAt = combined.length - limit;
  const cut = combined.slice(cutAt);
  return cut.slice(splitSequenceLength(combined, cutAt, cut));
}

// ---------------------------------------------------------------------------------------
// Mode state that fell off the FRONT of the tail.
//
// The replay is written into a terminal that was just reset, so it starts from "every
// private mode off, normal buffer". That is only right if the bytes that turned the modes
// on are still in the tail. They are not, for long: tmux enters the alternate screen
// (`CSI ? 1049 h`) once, as the very first bytes after attach, and never again — every
// later redraw repaints in place. After a megabyte of output the tail begins somewhere
// inside those repaints, and a reattach replays full-screen frames into the NORMAL
// buffer: the screen looks right, but xterm is not in the alternate buffer, so the wheel
// scrolls xterm's (empty) scrollback instead of reaching tmux / the app. The pane shows
// exactly one screen and cannot scroll back. Only panes that were reattached after
// enough output show it, which is why it looks random.
//
// So each time the tail drops bytes, the dropped bytes are folded into the set of private
// modes that were ON at the new head, and a replay starts by re-asserting those. The
// dropped region always holds whole sequences: appendBoundedOutput cuts on a sequence
// boundary, and the previous head was such a boundary too.

export interface ReplayTail {
  readonly text: string;
  /** DEC private modes (`CSI ? Pm h`) on at the start of `text`, in the order they were set. */
  readonly headModes: ReadonlySet<number>;
}

export const EMPTY_REPLAY_TAIL: ReplayTail = { text: "", headModes: new Set() };

const PRIVATE_MODE_RE = new RegExp(ESC + "\\[\\?([0-9;:]*)([hl])", "g");

/** Fold every DECSET/DECRST in `dropped` into `modes`. Exported for tests. */
export function foldPrivateModes(modes: ReadonlySet<number>, dropped: string): Set<number> {
  const out = new Set(modes);
  for (const match of dropped.matchAll(PRIVATE_MODE_RE)) {
    const set = match[2] === "h";
    for (const param of match[1].split(";")) {
      // A parameter may carry colon sub-parameters; the mode is the leading number.
      const mode = Number.parseInt(param, 10);
      if (Number.isNaN(mode)) continue;
      if (set) {
        out.delete(mode); // re-add so the set keeps SET order, not first-seen order
        out.add(mode);
      } else out.delete(mode);
    }
  }
  return out;
}

export function appendReplayTail(tail: ReplayTail, data: string, limit: number): ReplayTail {
  const text = appendBoundedOutput(tail.text, data, limit);
  const droppedLength = tail.text.length + data.length - text.length;
  if (droppedLength === 0) return { text, headModes: tail.headModes };
  // Sliced off the parts rather than off a second `tail.text + data`: this runs on every
  // chunk of every pane, and flattening a megabyte twice per chunk is a cost worth skipping.
  const dropped = droppedLength <= tail.text.length ? tail.text.slice(0, droppedLength) : tail.text + data.slice(0, droppedLength - tail.text.length);
  return { text, headModes: foldPrivateModes(tail.headModes, dropped) };
}

// The alternate-screen modes go first: 1049 also clears the screen it switches to, and
// everything else must land in THAT buffer.
const ALT_SCREEN_MODES = new Set([47, 1047, 1049]);

// One sequence per mode, never a combined `CSI ? 1049 ; 1000 h`: the client drops a
// SET whose parameters are ALL mouse modes (src/composables/mouseTrackingModes.ts) and
// lets a mixed one through, so bundling a mouse mode with 1049 would hand xterm native
// mouse tracking — and turn a drag back into escape bytes typed at the prompt (#729).
export function replayPrefix(headModes: ReadonlySet<number>): string {
  const modes = [...headModes];
  const ordered = [...modes.filter((m) => ALT_SCREEN_MODES.has(m)), ...modes.filter((m) => !ALT_SCREEN_MODES.has(m))];
  return ordered.map((mode) => `${ESC}[?${mode}h`).join("");
}

/** What a reattaching client is sent: the head modes, then the tail minus its queries. */
export const replayOf = (tail: ReplayTail): string => replayPrefix(tail.headModes) + stripTerminalQueries(tail.text);

/** What a headless render consumes: the head modes, then the tail verbatim (queries are
 *  kept there on purpose — see headlessScreen.ts). */
export const screenSourceOf = (tail: ReplayTail): string => replayPrefix(tail.headModes) + tail.text;
