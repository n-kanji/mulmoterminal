// Per-account credential stores — what lets two claude.ai subscriptions be logged in AT THE
// SAME TIME, so one grid page can run on one account while another page runs on the other
// (operator request 2026-09-14; the switcher next door swaps ONE global login instead).
//
// Claude Code 2.1.270 derives its Keychain service name from the credential-store directory:
//
//   function iH(n=""){let e=process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR,
//     t=e!==void 0?!e:!process.env.CLAUDE_CONFIG_DIR,
//     r=e!==void 0?e.normalize("NFC"):configHome(),
//     c=t?"":`-${sha256(r).slice(0,8)}`; return `Claude Code${OAUTH_FILE_SUFFIX}${n}${c}`}
//
// so `CLAUDE_SECURESTORAGE_CONFIG_DIR=<dir>` gives that PROCESS its own credential entry
// while `~/.claude` — settings, skills, CLAUDE.md, history — stays shared. `CLAUDE_CONFIG_DIR`
// would split those too, which is why it is not what this uses. The variable has to reach the
// child as PROCESS env: the CLI resolves its store before settings are read, and says so
// ("set it in the shell, not a settings file, and restart").
//
// Refresh tokens ROTATE, so the same credential living in two Keychain entries means the
// first refresh invalidates the other copy. Two rules keep that from happening:
//   - the account that is currently live in the default slot spawns with NO env — it uses
//     that slot rather than a copy of it;
//   - a per-account entry is seeded only when ABSENT, never overwritten; once it exists it
//     owns its own rotation.
// With nothing to seed from, the pane simply starts at "Not logged in · Please run /login",
// and one login there fills its entry for good.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  CLAUDE_KEYCHAIN_SERVICE,
  emailOf,
  normalizeEmail,
  parseSnapshot,
  readOauthAccount,
  realIo,
  serviceForEmail,
  type ClaudeAccountIo,
} from "./claude-account.js";

// The env var the child reads. Exported so the spawn path and its tests name it once.
export const STORE_ENV_VAR = "CLAUDE_SECURESTORAGE_CONFIG_DIR";

export const accountStoreRoot = (): string => path.join(os.homedir(), ".mulmoterminal", "accounts");

// One directory per account. Only its STRING is load-bearing (it is what the CLI hashes), so
// it is normalized here — an absolute, NFC path with no trailing separator — and never
// rebuilt anywhere else: a different spelling of the same directory is a different Keychain
// entry, i.e. a pane that is silently logged out.
export function accountStoreDir(email: string, root: string = accountStoreRoot()): string {
  const slug = normalizeEmail(email).replace(/[^a-z0-9._@+-]+/g, "_");
  return path.resolve(root, slug).normalize("NFC");
}

// The Keychain service Claude Code will read and write for a session pointed at `dir`.
// Mirrors the CLI's own derivation (see the header) — the prod OAuth suffix is empty.
export function keychainServiceForDir(dir: string): string {
  const hash = createHash("sha256").update(dir.normalize("NFC")).digest("hex").slice(0, 8);
  return `${CLAUDE_KEYCHAIN_SERVICE}-${hash}`;
}

export interface AccountStoreIo extends ClaudeAccountIo {
  ensureDir(dir: string): Promise<void>;
}

export function realStoreIo(): AccountStoreIo {
  return {
    ...realIo(),
    // 0700: the store holds a credentials file whenever the Keychain is unavailable.
    ensureDir: async (dir) => {
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    },
  };
}

// The env a claude spawn needs to run as `email`, or {} for "whatever the default slot holds"
// — which is both the no-account answer and the answer for the account that IS the default.
export async function accountSpawnEnv(email: string | null | undefined, io: AccountStoreIo = realStoreIo()): Promise<Record<string, string>> {
  if (!email) return {};
  const target = normalizeEmail(email);
  if (!target) return {};
  const live = emailOf(readOauthAccount(await io.readFile(io.claudeJsonPath)));
  if (live === target) return {};
  const dir = accountStoreDir(target);
  await io.ensureDir(dir);
  await seedStore(io, target, dir);
  return { [STORE_ENV_VAR]: dir };
}

// Give a brand-new store the account's snapshotted login, so switching a page to an account
// that MT already knows costs no re-login. An existing entry is left alone — see the header.
async function seedStore(io: AccountStoreIo, email: string, dir: string): Promise<void> {
  const service = keychainServiceForDir(dir);
  if (await io.readKeychain(service)) return;
  const snapshot = parseSnapshot(await io.readKeychain(serviceForEmail(email)));
  if (!snapshot) {
    console.warn(`[claude-account] no stored login for ${email} — its panes will ask you to run /login once.`);
    return;
  }
  await io.writeKeychain(service, snapshot.credentials);
  console.log(`[claude-account] seeded the credential store for ${email}`);
}
