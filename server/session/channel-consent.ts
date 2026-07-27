// Auto-confirming Claude Code's development-channels consent prompt (opt-in, fork-local).
//
// A `claude` spawned with `--dangerously-load-development-channels` (here: via a CLAUDE_BIN
// wrapper that loads the local claude-peers channel) stops at an interactive
// "I am using this for local development / Exit" chooser BEFORE the TUI comes up. In a
// hand-driven terminal the owner presses Enter every time; in a spawned grid cell the
// session just sits there looking hung, and nothing downstream (draft injection, the
// peers channel itself) ever runs.
//
// When the operator has declared — via MULMOTERMINAL_AUTOCONFIRM_CHANNELS — that a specific
// channel list is their own local development setup, pressing that Enter for them is the
// same consent they already give by hand on every interactive launch.
//
// Deliberately narrow, in three independent ways:
// - fires ONCE per session, and only when the consent sentence, the chooser's Exit row,
//   AND the exact channel list from the env var are all on screen. A session carrying any
//   other channel list is left waiting for a human, which is the prompt's whole point.
// - DISARMS the moment the TUI paints (the same readiness marker draft-injection waits
//   for) or after ARM_WINDOW_MS, whichever comes first. The chooser only ever appears
//   pre-TUI, so past that point the scanner must be dead: without this, merely VIEWING
//   this file (or its spec, or README-KANJI — all contain both match strings) from a
//   MulmoTerminal-spawned claude would send a stray Enter into a live session.
// - every miss is silent-but-safe: any gap here leaves the chooser waiting for a human.
import { claudeAdapter } from "../agents/claude.js";
import type { PtyEntry } from "./types.js";

const CONSENT_PROMPT_TEXT = "using this for local development";
// The chooser's other row. Requiring it keeps prose ABOUT the prompt (docs, specs, code
// review output) from matching: prose quotes the sentence, not the menu.
const CONSENT_EXIT_ROW = "2. Exit";
// The chooser appears within the first seconds of a spawn; well past that the session is
// interactive and a match can only be a false positive.
const ARM_WINDOW_MS = 30_000;
// Enter is sent a beat after the prompt paints, for the same reason draft-injection
// settles: the chooser is still wiring its key handler while the first bytes stream out.
const CONSENT_SETTLE_MS = 300;
// The TUI's input-box readiness marker — once this paints, the consent phase is over.
const TUI_READY_MARKER = claudeAdapter.draftReadyMarker;

// Claude's chooser lays the sentence out WORD BY WORD — in a live pty each word is
// placed with its own cursor-column move (`ESC[NG`, no literal spaces at all; captured
// by a node-pty probe), and a tmux re-render styles each word with its own SGR pair —
// so the raw stream never carries the sentence contiguously. Matching therefore runs on
// a copy where every escape sequence became a SPACE and whitespace is collapsed, which
// normalizes both layouts back to plain words. Stripping the joined scan window rather
// than each chunk also heals an escape sequence split across two reads.
//
// Two passes (one regex trips sonarjs/regex-complexity): first CSI (with `:`-form SGR
// params, private prefixes and intermediate bytes) and OSC (ESC-excluded body so an
// unterminated one can't swallow the window; terminator optional so a split/truncated
// one still vanishes) — then charset designation (tmux's `ESC(B`) and the remaining
// two-byte Fe/Fp escapes (ESC 7/8/M/= …).
// eslint-disable-next-line no-control-regex, sonarjs/no-control-regex -- intentional: match ESC-led CSI/OSC sequences to strip them
const CSI_OSC_RE = /\x1b\[[0-9;:?<=>]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g;
// eslint-disable-next-line no-control-regex, sonarjs/no-control-regex -- intentional: match two-byte terminal escapes to strip them
const TWO_BYTE_ESC_RE = /\x1b[()#%][0-9A-Za-z]|\x1b[0-9<=>@-Z\\^_]/g;

// Pure so the match is testable without a PTY: the consent sentence, the Exit row and
// the exact channel list must all be visible in the (bounded, escape-normalized) window.
export function consentPromptVisible(scan: string, wantedChannels: string): boolean {
  const plain = scan.replace(CSI_OSC_RE, " ").replace(TWO_BYTE_ESC_RE, " ").replace(/\s+/g, " ");
  return plain.includes(CONSENT_PROMPT_TEXT) && plain.includes(CONSENT_EXIT_ROW) && plain.includes(wantedChannels);
}

// Composes the consent scanner in FRONT of another pty-output scanner, so the call site
// (spawn-claude's already-at-the-lint-limit spawner) feeds one scanner, not two.
export function withChannelConsent(entry: PtyEntry, next: (data: string) => void, env: NodeJS.ProcessEnv = process.env): (data: string) => void {
  const consent = attachChannelConsentAutoConfirm(entry, env);
  return (data: string) => {
    try {
      consent(data);
    } finally {
      next(data);
    }
  };
}

// Returns a scanner to feed the pty output to (like attachDraftInjection). No-op unless
// MULMOTERMINAL_AUTOCONFIRM_CHANNELS names the channel list to auto-confirm.
export function attachChannelConsentAutoConfirm(entry: PtyEntry, env: NodeJS.ProcessEnv = process.env): (data: string) => void {
  const wanted = env.MULMOTERMINAL_AUTOCONFIRM_CHANNELS?.trim();
  if (!wanted) return () => {};
  let done = false;
  let scan = "";
  const expire = setTimeout(() => {
    done = true;
  }, ARM_WINDOW_MS);
  const disarm = () => {
    done = true;
    scan = "";
    clearTimeout(expire);
  };
  return (data: string) => {
    if (done) return;
    scan = (scan + data).slice(-4096);
    // TUI painted → the consent phase never happened or is already behind us.
    if (TUI_READY_MARKER.test(scan)) return disarm();
    if (!consentPromptVisible(scan, wanted)) return;
    disarm();
    console.log(`[consent] auto-confirming the dev-channels chooser (${wanted})`);
    setTimeout(() => {
      try {
        entry.term.write("\r");
      } catch {
        // pty already gone — nothing to confirm
      }
    }, CONSENT_SETTLE_MS);
  };
}
