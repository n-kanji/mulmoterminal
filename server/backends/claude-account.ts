// Claude account switching for the toolbar (ported from the operator's ClaudeBar menu app):
// the header shows which claude.ai account Claude Code is logged into, and one click swaps
// to another account — for the moment a usage limit hits on one subscription.
//
// How a swap works: Claude Code keeps its OAuth tokens in ONE macOS Keychain entry
// ("Claude Code-credentials") plus an `oauthAccount` profile block in ~/.claude.json. We
// snapshot the inactive account's pair into an MT-owned Keychain entry (tokens never touch
// disk — a refresh token in a 0600 file would be a downgrade from the Keychain it came from)
// and switching is: save the live pair into the outgoing account's snapshot, restore the
// incoming account's snapshot into the live slots. Only a small index of emails lives on
// disk (~/.mulmoterminal/claude-accounts.json) so the dropdown can list accounts without
// touching the Keychain.
//
// Already-running panes keep their in-process token until its next refresh, so a switch
// reliably applies to NEW panes only — the UI says so instead of pretending otherwise.
// All keychain IO goes through /usr/bin/security: the Apple-signed CLI reads without the
// ACL prompt that direct API access from an unsigned process would trigger (same technique
// ClaudeBar uses in production).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Express, Request, Response } from "express";
import { isRecord } from "../../common/isRecord.js";

const execFileP = promisify(execFile);

// Claude Code's own credential slot — read and overwritten on switch, never renamed.
export const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";
// One MT-owned snapshot entry per account. The prefix makes every entry self-describing in
// Keychain Access, and keeps us out of any other app's namespace.
export const SNAPSHOT_SERVICE_PREFIX = "MulmoTerminal-claude-account:";

export const normalizeEmail = (email: string): string => email.trim().toLowerCase();
export const serviceForEmail = (email: string): string => `${SNAPSHOT_SERVICE_PREFIX}${normalizeEmail(email)}`;

// ---- ~/.claude.json (the profile block) -------------------------------------------------

// The `oauthAccount` block as Claude Code wrote it. We treat it as opaque — copy the whole
// object across, read only `emailAddress` — so new fields Claude Code adds survive a swap.
export function readOauthAccount(claudeJsonRaw: string | null): Record<string, unknown> | null {
  if (!claudeJsonRaw) return null;
  try {
    const parsed: unknown = JSON.parse(claudeJsonRaw);
    if (!isRecord(parsed) || !isRecord(parsed.oauthAccount)) return null;
    return parsed.oauthAccount;
  } catch {
    return null;
  }
}

export function emailOf(oauthAccount: Record<string, unknown> | null): string | null {
  const email = oauthAccount?.emailAddress;
  return typeof email === "string" && email.trim() ? normalizeEmail(email) : null;
}

// Replace (or remove, with null) ONLY the `oauthAccount` key, preserving everything else in
// ~/.claude.json. Throws on unparseable input: overwriting a file we could not parse would
// destroy state Claude Code still wants.
export function withOauthAccount(claudeJsonRaw: string, oauthAccount: Record<string, unknown> | null): string {
  const parsed: unknown = JSON.parse(claudeJsonRaw);
  if (!isRecord(parsed)) throw new Error("claude.json is not an object");
  if (oauthAccount === null) delete parsed.oauthAccount;
  else parsed.oauthAccount = oauthAccount;
  return JSON.stringify(parsed, null, 2);
}

// ---- the on-disk index (emails only, no secrets) ----------------------------------------

export interface AccountIndexEntry {
  email: string;
  savedAt: string; // ISO timestamp of the last snapshot for this account
}

export function parseIndex(raw: string | null): AccountIndexEntry[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || !Array.isArray(parsed.accounts)) return [];
    const out: AccountIndexEntry[] = [];
    for (const entry of parsed.accounts) {
      if (!isRecord(entry) || typeof entry.email !== "string" || !entry.email.trim()) continue;
      out.push({ email: normalizeEmail(entry.email), savedAt: typeof entry.savedAt === "string" ? entry.savedAt : "" });
    }
    return out;
  } catch {
    return [];
  }
}

export function upsertIndexEntry(entries: AccountIndexEntry[], email: string, savedAt: string): AccountIndexEntry[] {
  const normalized = normalizeEmail(email);
  const rest = entries.filter((e) => e.email !== normalized);
  return [...rest, { email: normalized, savedAt }].sort((a, b) => a.email.localeCompare(b.email));
}

export const serializeIndex = (entries: AccountIndexEntry[]): string => JSON.stringify({ accounts: entries }, null, 2);

// ---- the snapshot payload (lives inside a Keychain entry) --------------------------------

interface Snapshot {
  credentials: string; // the raw "Claude Code-credentials" value, verbatim
  oauthAccount: Record<string, unknown> | null;
  savedAt: string;
}

export function parseSnapshot(raw: string | null): Snapshot | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || typeof parsed.credentials !== "string" || !parsed.credentials) return null;
    return {
      credentials: parsed.credentials,
      oauthAccount: isRecord(parsed.oauthAccount) ? parsed.oauthAccount : null,
      savedAt: typeof parsed.savedAt === "string" ? parsed.savedAt : "",
    };
  } catch {
    return null;
  }
}

// ---- IO seam (injected in tests so they never touch the real Keychain) -------------------

export interface ClaudeAccountIo {
  readKeychain(service: string): Promise<string | null>; // null = no such entry
  writeKeychain(service: string, value: string): Promise<void>;
  deleteKeychain(service: string): Promise<void>; // absent entry is not an error
  readFile(filePath: string): Promise<string | null>; // null = no such file
  writeFile(filePath: string, data: string): Promise<void>;
  claudeJsonPath: string;
  indexPath: string;
  now(): Date;
}

export function realIo(): ClaudeAccountIo {
  const home = os.homedir();
  return {
    async readKeychain(service) {
      try {
        // -w prints the password only; trailing newline is the CLI's, not the value's.
        const { stdout } = await execFileP("/usr/bin/security", ["find-generic-password", "-s", service, "-w"]);
        const value = stdout.replace(/\n$/, "");
        return value || null;
      } catch (e) {
        if (isNotFound(e)) return null;
        throw e;
      }
    },
    async writeKeychain(service, value) {
      // -U updates in place, so no delete-then-add window where the entry is missing.
      await execFileP("/usr/bin/security", ["add-generic-password", "-s", service, "-a", os.userInfo().username, "-w", value, "-U"]);
    },
    async deleteKeychain(service) {
      try {
        await execFileP("/usr/bin/security", ["delete-generic-password", "-s", service]);
      } catch (e) {
        if (!isNotFound(e)) throw e;
      }
    },
    async readFile(filePath) {
      try {
        return await fs.readFile(filePath, "utf8");
      } catch {
        return null;
      }
    },
    async writeFile(filePath, data) {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, data, "utf8");
    },
    claudeJsonPath: path.join(home, ".claude.json"),
    indexPath: path.join(home, ".mulmoterminal", "claude-accounts.json"),
    now: () => new Date(),
  };
}

function isNotFound(e: unknown): boolean {
  const msg = e instanceof Error ? `${(e as { stderr?: string }).stderr ?? ""} ${e.message}` : String(e);
  return msg.includes("could not be found") || msg.includes("SecKeychainSearchCopyNext");
}

// ---- routes -------------------------------------------------------------------------------

interface ClaudeAccountRouteOptions {
  isAllowedOrigin: (origin: string | undefined, remoteAddress: string | undefined) => boolean;
  // Restart every visible claude pane so it resumes its conversation on the freshly-swapped
  // credentials (session/restart-claude-panes.ts), returning how many restarted. Injected —
  // this module owns credentials, not the session registry. Absent (tests that don't care)
  // means "restart is unavailable" and restart requests report 0.
  restartPanes?: () => number;
}

export function mountClaudeAccountRoutes(app: Express, { isAllowedOrigin, restartPanes }: ClaudeAccountRouteOptions, io: ClaudeAccountIo = realIo()): void {
  // Current identity + the stored account list. `current` comes from ~/.claude.json every
  // time (never cached), so a login done outside MT — `claude /logout` in any pane — is
  // reflected on the next open of the dropdown without any bookkeeping here.
  app.get("/api/claude-account", async (_req, res) => {
    try {
      const oauthAccount = readOauthAccount(await io.readFile(io.claudeJsonPath));
      const accounts = parseIndex(await io.readFile(io.indexPath));
      res.json({ current: emailOf(oauthAccount), accounts });
    } catch (e) {
      res.status(500).json({ error: message(e) });
    }
  });

  // Swap the live credentials to a previously snapshotted account. State-changing and
  // local-only, so origin-guarded like open-dir.
  app.post("/api/claude-account/switch", async (req, res) => {
    if (!guard(req, res, isAllowedOrigin)) return;
    const target = isRecord(req.body) && typeof req.body.email === "string" ? normalizeEmail(req.body.email) : "";
    if (!target) return void res.status(400).json({ error: "email required" });
    try {
      await handleSwitch(io, req, res, target, restartPanes);
    } catch (e) {
      res.status(500).json({ error: message(e) });
    }
  });

  // The fleet restart on its own: for a switch done with the box unticked, or done outside
  // MT entirely (`claude /logout` + login in a pane) — either way the operator can still
  // move every existing pane onto whatever the live credentials now are.
  app.post("/api/claude-account/restart-panes", (req, res) => {
    if (!guard(req, res, isAllowedOrigin)) return;
    try {
      res.json({ ok: true, restartedPanes: restartPanes ? restartPanes() : 0 });
    } catch (e) {
      res.status(500).json({ error: message(e) });
    }
  });

  // The add-a-new-account path (the ClaudeBar flow, minus the typing): snapshot the current
  // login, then clear the live slots so the next `claude` in a fresh pane starts the OAuth
  // login. Nothing is lost — the cleared account is one switch away.
  app.post("/api/claude-account/logout", async (req, res) => {
    if (!guard(req, res, isAllowedOrigin)) return;
    try {
      const claudeJsonRaw = await io.readFile(io.claudeJsonPath);
      const currentEmail = emailOf(readOauthAccount(claudeJsonRaw));
      const liveCredentials = await io.readKeychain(CLAUDE_KEYCHAIN_SERVICE);
      if (!liveCredentials) return void res.json({ ok: true, current: null });
      if (!currentEmail) {
        // Credentials with no identity: refuse rather than snapshot under a name we invented
        // — the operator would have no way to switch back to it.
        return void res.status(409).json({ error: "Cannot identify the current account; run claude /logout in a pane instead." });
      }
      const index = parseIndex(await io.readFile(io.indexPath));
      const updated = await snapshotCurrent(io, index, claudeJsonRaw, currentEmail);
      await io.writeFile(io.indexPath, serializeIndex(updated));
      await io.deleteKeychain(CLAUDE_KEYCHAIN_SERVICE);
      if (claudeJsonRaw) await io.writeFile(io.claudeJsonPath, withOauthAccount(claudeJsonRaw, null));
      res.json({ ok: true, current: null });
    } catch (e) {
      res.status(500).json({ error: message(e) });
    }
  });
}

// The switch itself, once the request has passed the guard and named a target.
async function handleSwitch(io: ClaudeAccountIo, req: Request, res: Response, target: string, restartPanes?: () => number): Promise<void> {
  const claudeJsonRaw = await io.readFile(io.claudeJsonPath);
  const currentEmail = emailOf(readOauthAccount(claudeJsonRaw));
  if (target === currentEmail) return void res.json({ ok: true, current: currentEmail });

  const snapshot = parseSnapshot(await io.readKeychain(serviceForEmail(target)));
  if (!snapshot) {
    return void res.status(404).json({ error: `No stored login for ${target}. Log in once as that account first.` });
  }

  // Save the outgoing account before touching anything — its live tokens are the only
  // copy, and they are freshest right now.
  let index = parseIndex(await io.readFile(io.indexPath));
  index = await snapshotCurrent(io, index, claudeJsonRaw, currentEmail);

  await io.writeKeychain(CLAUDE_KEYCHAIN_SERVICE, snapshot.credentials);
  // Claude Code renders its identity from `oauthAccount`, not from the token, so the
  // profile block must travel with the credentials (display-only: a race against a live
  // pane rewriting claude.json costs a stale label, never a broken login).
  if (claudeJsonRaw && snapshot.oauthAccount) {
    await io.writeFile(io.claudeJsonPath, withOauthAccount(claudeJsonRaw, snapshot.oauthAccount));
  }
  await io.writeFile(io.indexPath, serializeIndex(upsertIndexEntry(index, target, snapshot.savedAt)));
  // The credentials are swapped; now move the FLEET. A running claude keeps its token
  // in-process for life, so without this the twenty existing panes — the ones stuck on
  // the old account's usage limit — would stay stuck. Restart-and-resume puts each one
  // back into its own conversation on the new account.
  const restarted = isRecord(req.body) && req.body.restartPanes === true && restartPanes ? restartPanes() : 0;
  res.json({ ok: true, current: target, restartedPanes: restarted });
}

// Snapshot the live credentials under the current account's entry and return the index with
// that account upserted. A missing live keychain or unknown identity is a no-op: there is
// nothing worth saving, and the switch itself can still proceed.
async function snapshotCurrent(
  io: ClaudeAccountIo,
  index: AccountIndexEntry[],
  claudeJsonRaw: string | null,
  currentEmail: string | null,
): Promise<AccountIndexEntry[]> {
  if (!currentEmail) return index;
  const credentials = await io.readKeychain(CLAUDE_KEYCHAIN_SERVICE);
  if (!credentials) return index;
  const savedAt = io.now().toISOString();
  const snapshot: Snapshot = { credentials, oauthAccount: readOauthAccount(claudeJsonRaw), savedAt };
  await io.writeKeychain(serviceForEmail(currentEmail), JSON.stringify(snapshot));
  return upsertIndexEntry(index, currentEmail, savedAt);
}

function guard(req: Request, res: Response, isAllowedOrigin: ClaudeAccountRouteOptions["isAllowedOrigin"]): boolean {
  if (isAllowedOrigin(req.headers.origin, req.socket?.remoteAddress)) return true;
  res.status(403).json({ error: "forbidden origin" });
  return false;
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
