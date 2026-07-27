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
// Deliberately narrow: fires ONCE per session, and only when the consent prompt text and
// the exact channel list from the env var are both on screen. A session that carries any
// other channel list is left waiting for a human, which is the prompt's whole point.
import type { PtyEntry } from "./types.js";

const CONSENT_PROMPT_TEXT = "using this for local development";
// Claude's chooser lays that sentence out WORD BY WORD — in a live pty each word is
// placed with its own cursor-column move (`ESC[NG`, no literal spaces at all; captured
// by a node-pty probe), and a tmux re-render styles each word with its own SGR pair —
// so the raw stream never carries the sentence contiguously. Matching therefore runs on
// a copy where every escape sequence became a SPACE and whitespace is collapsed, which
// normalizes both layouts back to plain words. Stripping the joined scan window rather
// than each chunk also heals an escape sequence split across two reads.
// eslint-disable-next-line no-control-regex, sonarjs/no-control-regex -- intentional: match ESC-led CSI/OSC sequences to strip them
const ESCAPE_SEQ_RE = /\x1b\[[0-9;?]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)/g;
// Enter is sent a beat after the prompt paints, for the same reason draft-injection
// settles: the chooser is still wiring its key handler while the first bytes stream out.
const CONSENT_SETTLE_MS = 300;

// Pure so the match is testable without a PTY: both the prompt sentence and the exact
// channel list must be visible in the (bounded, escape-stripped) scan window.
export function consentPromptVisible(scan: string, wantedChannels: string): boolean {
  const plain = scan.replace(ESCAPE_SEQ_RE, " ").replace(/\s+/g, " ");
  return plain.includes(CONSENT_PROMPT_TEXT) && plain.includes(wantedChannels);
}

// Composes the consent scanner in FRONT of another pty-output scanner, so the call site
// (spawn-claude's already-at-the-lint-limit spawner) feeds one scanner, not two.
export function withChannelConsent(entry: PtyEntry, next: (data: string) => void, env: NodeJS.ProcessEnv = process.env): (data: string) => void {
  const consent = attachChannelConsentAutoConfirm(entry, env);
  return (data: string) => {
    consent(data);
    next(data);
  };
}

// Returns a scanner to feed the pty output to (like attachDraftInjection). No-op unless
// MULMOTERMINAL_AUTOCONFIRM_CHANNELS names the channel list to auto-confirm.
export function attachChannelConsentAutoConfirm(entry: PtyEntry, env: NodeJS.ProcessEnv = process.env): (data: string) => void {
  const wanted = env.MULMOTERMINAL_AUTOCONFIRM_CHANNELS?.trim();
  if (!wanted) return () => {};
  let done = false;
  let scan = "";
  return (data: string) => {
    if (done) return;
    scan = (scan + data).slice(-4096);
    if (!consentPromptVisible(scan, wanted)) return;
    done = true;
    scan = "";
    setTimeout(() => {
      try {
        entry.term.write("\r");
      } catch {
        // pty already gone — nothing to confirm
      }
    }, CONSENT_SETTLE_MS);
  };
}
