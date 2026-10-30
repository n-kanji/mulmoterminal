// Auto-confirming Claude Code's workspace-trust chooser for the operator's own project
// roots (opt-in, fork-local). Sibling of channel-consent.ts — same shape, same guards.
//
// The first time `claude` starts in a directory it stops BEFORE the TUI at
// "Quick safety check: Is this a project you created or one you trust?" with the cursor on
// "No, exit". A spawned grid cell has nobody to answer, and worse: draft injection types the
// first prompt + Enter once anything looks ready, so the Enter lands on "No, exit" and the
// session dies about seven seconds after it was created (operator report 2026-10-30:
// 大阪玩具_Bカート, three times in a row, nothing in the phone's session list). The same stall
// bites every column a Claude Code session opens for another one (peer messaging, the
// launcher, orchestrator worktrees) because each of those is "a new directory" to claude.
//
// When the operator declares, via MULMOTERMINAL_AUTOTRUST_ROOTS (colon-separated absolute
// directories), that everything under those roots is their own work, answering "Yes" for a
// cwd inside one of them is the consent they already give by hand on every first launch.
//
// Deliberately narrow, the same three ways as the dev-channels auto-confirm:
// - fires ONCE per session, only when the question, BOTH answer rows and the confirm hint
//   are on screen, and only for a cwd (realpath) under a declared root. Anything else —
//   Downloads, /tmp, a cloned stranger's repo outside the roots — is left for a human.
// - DISARMS the moment the TUI paints or after ARM_WINDOW_MS. Past that point a match can
//   only be prose about the prompt (this file, its spec, README-KANJI) scrolling by.
// - every miss is silent-but-safe: the chooser just keeps waiting, which is today's behaviour.
import fs from "node:fs";
import path from "node:path";
import { claudeAdapter } from "../agents/claude.js";
import { normalizeScan } from "./channel-consent.js";
import type { PtyEntry } from "./types.js";

const TRUST_QUESTION = "one you trust";
const TRUST_YES_ROW = "Yes, I trust this folder";
const TRUST_NO_ROW = "No, exit";
const TRUST_CONFIRM_HINT = "Enter to confirm";
const ARM_WINDOW_MS = 30_000;
const SETTLE_MS = 300;
const KEY_GAP_MS = 150;
const DOWN_ARROW = "\x1b[B";
const TUI_READY_MARKER = claudeAdapter.draftReadyMarker;

// Pure: the chooser is on screen when the question, both rows and the confirm hint are all
// visible in the escape-normalized window. Prose quoting the question never carries both
// rows AND the key hint together.
export function trustPromptVisible(scan: string): boolean {
  const plain = normalizeScan(scan);
  return plain.includes(TRUST_QUESTION) && plain.includes(TRUST_YES_ROW) && plain.includes(TRUST_NO_ROW) && plain.includes(TRUST_CONFIRM_HINT);
}

// Pure: where the cursor sits. Claude has shipped both orders of the two rows, so the key
// sequence is derived from the screen rather than assumed: "Yes" under the cursor → Enter;
// otherwise → Down then Enter. (The rows are adjacent, so one Down always reaches "Yes".)
export function trustCursorOnYes(scan: string): boolean {
  return /❯\s*Yes, I trust/.test(normalizeScan(scan));
}

// Pure: is `cwd` inside one of the declared roots? Both sides are resolved to real paths
// so a symlinked worktree or a `..` segment can't slip a foreign directory under a root.
export function autoTrustAllowed(cwd: string, rootsSpec: string | undefined, realpath: (p: string) => string = safeRealpath): boolean {
  const roots = (rootsSpec ?? "")
    .split(":")
    .map((r) => r.trim())
    .filter((r) => path.isAbsolute(r));
  if (!roots.length) return false;
  const real = realpath(cwd);
  return roots.some((root) => {
    let r = realpath(root);
    while (r.length > 1 && r.endsWith(path.sep)) r = r.slice(0, -1);
    return real === r || real.startsWith(r + path.sep);
  });
}

function safeRealpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

// Composes the trust scanner in FRONT of another pty-output scanner (see withChannelConsent).
export function withTrustConsent(entry: PtyEntry, cwd: string, next: (data: string) => void, env: NodeJS.ProcessEnv = process.env): (data: string) => void {
  const trust = attachTrustAutoConfirm(entry, cwd, env);
  return (data: string) => {
    try {
      trust(data);
    } finally {
      next(data);
    }
  };
}

// Returns a scanner to feed the pty output to. No-op unless MULMOTERMINAL_AUTOTRUST_ROOTS is
// set AND the session's cwd is under one of its roots.
export function attachTrustAutoConfirm(entry: PtyEntry, cwd: string, env: NodeJS.ProcessEnv = process.env): (data: string) => void {
  if (!autoTrustAllowed(cwd, env.MULMOTERMINAL_AUTOTRUST_ROOTS)) return () => {};
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
  const press = (keys: string) => {
    try {
      entry.term.write(keys);
    } catch {
      // pty already gone — nothing to confirm
    }
  };
  return (data: string) => {
    if (done) return;
    scan = (scan + data).slice(-4096);
    if (TUI_READY_MARKER.test(scan)) return disarm();
    if (!trustPromptVisible(scan)) return;
    const onYes = trustCursorOnYes(scan);
    disarm();
    console.log(`[trust] auto-confirming the workspace-trust chooser for ${cwd} (${onYes ? "Enter" : "Down, Enter"})`);
    if (onYes) {
      setTimeout(() => press("\r"), SETTLE_MS);
    } else {
      setTimeout(() => press(DOWN_ARROW), SETTLE_MS);
      setTimeout(() => press("\r"), SETTLE_MS + KEY_GAP_MS);
    }
  };
}
