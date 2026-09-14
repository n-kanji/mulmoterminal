// @vitest-environment node
// Per-account credential stores — the thing that lets two subscriptions be logged in at
// once. In-memory IO throughout: no real Keychain, no ~/.claude.json, no network.
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";

import { STORE_ENV_VAR, accountSpawnEnv, accountStoreDir, keychainServiceForDir, type AccountStoreIo } from "../../../server/backends/claude-account-store.js";
import { CLAUDE_KEYCHAIN_SERVICE, serviceForEmail } from "../../../server/backends/claude-account.js";

const CLAUDE_JSON = "/home/.claude.json";
const INDEX = "/home/.mulmoterminal/claude-accounts.json";
const ROOT = "/home/.mulmoterminal/accounts";

function fakeIo(seed: { keychain?: Record<string, string>; files?: Record<string, string> } = {}) {
  const keychain = new Map(Object.entries(seed.keychain ?? {}));
  const files = new Map(Object.entries(seed.files ?? {}));
  const dirs: string[] = [];
  const io: AccountStoreIo = {
    readKeychain: async (s) => keychain.get(s) ?? null,
    writeKeychain: async (s, v) => void keychain.set(s, v),
    deleteKeychain: async (s) => void keychain.delete(s),
    readFile: async (p) => files.get(p) ?? null,
    writeFile: async (p, d) => void files.set(p, d),
    ensureDir: async (d) => void dirs.push(d),
    claudeJsonPath: CLAUDE_JSON,
    indexPath: INDEX,
    now: () => new Date("2026-09-14T00:00:00Z"),
  };
  return { io, keychain, files, dirs };
}

const claudeJson = (email: string) => JSON.stringify({ oauthAccount: { emailAddress: email } });
const snapshotFor = (email: string) =>
  JSON.stringify({ credentials: `creds-${email}`, oauthAccount: { emailAddress: email }, savedAt: "2026-09-01T00:00:00Z" });

describe("the store directory", () => {
  it("is absolute, per account, and stable", () => {
    expect(accountStoreDir("Board@Orosy.co.jp", ROOT)).toBe(`${ROOT}/board@orosy.co.jp`);
    expect(accountStoreDir("board@orosy.co.jp", ROOT)).toBe(accountStoreDir("  BOARD@OROSY.CO.JP ", ROOT));
  });

  it("cannot escape its root, whatever the address says", () => {
    expect(accountStoreDir("../../etc/passwd@x.co", ROOT)).toBe(`${ROOT}/.._.._etc_passwd@x.co`);
    // "." and ".." pass the character filter and would name the root and its PARENT.
    expect(accountStoreDir("..", ROOT)).toBe(`${ROOT}/_`);
    expect(accountStoreDir(".", ROOT)).toBe(`${ROOT}/_`);
  });
});

// The service name IS the contract with Claude Code (it derives the same string from the
// same directory). Pinned as a literal so a refactor of the formula cannot drift silently.
describe("the Keychain service name", () => {
  it("is the CLI's own derivation: the default entry plus 8 hex of sha256(dir)", () => {
    const dir = `${ROOT}/b@orosy.co.jp`;
    const hash = createHash("sha256").update(dir).digest("hex").slice(0, 8);
    expect(keychainServiceForDir(dir)).toBe(`${CLAUDE_KEYCHAIN_SERVICE}-${hash}`);
    // Pinned, so a refactor of the formula cannot drift silently. Checked against the real
    // CLI on 2026-09-14: with CLAUDE_SECURESTORAGE_CONFIG_DIR set, claude read the entry at
    // exactly this name — an empty one answered "Not logged in", and one seeded by hand
    // answered "OAuth session expired", which only the entry it actually reads can do.
    expect(keychainServiceForDir(dir)).toBe("Claude Code-credentials-d93a60a1");
  });
});

describe("accountSpawnEnv", () => {
  it("is empty for a pane with no account of its own", async () => {
    const { io } = fakeIo({ files: { [CLAUDE_JSON]: claudeJson("a@b.co") } });
    expect(await accountSpawnEnv(null, io)).toEqual({});
    expect(await accountSpawnEnv("", io)).toEqual({});
  });

  // The default slot already holds this account. A COPY of a rotating refresh token in a
  // second entry would invalidate one of the two on the next refresh, so there is no copy.
  it("is empty for the account that is already the live default", async () => {
    const { io, keychain } = fakeIo({ files: { [CLAUDE_JSON]: claudeJson("a@b.co") } });
    expect(await accountSpawnEnv("A@B.co", io)).toEqual({});
    expect([...keychain.keys()]).toEqual([]);
  });

  it("points another account at its own store, seeded from the snapshot MT holds", async () => {
    const { io, keychain, dirs } = fakeIo({
      files: { [CLAUDE_JSON]: claudeJson("a@b.co") },
      keychain: { [serviceForEmail("c@d.co")]: snapshotFor("c@d.co") },
    });
    const env = await accountSpawnEnv("c@d.co", io);
    const dir = env[STORE_ENV_VAR];
    expect(dir).toBe(accountStoreDir("c@d.co"));
    expect(dirs).toEqual([dir]);
    // Seeded with the RAW credential, exactly as Claude Code stores it — not the snapshot
    // envelope, which the CLI would fail to parse.
    expect(keychain.get(keychainServiceForDir(dir))).toBe("creds-c@d.co");
  });

  it("never overwrites a store that already has a login", async () => {
    const dir = accountStoreDir("c@d.co");
    const { io, keychain } = fakeIo({
      files: { [CLAUDE_JSON]: claudeJson("a@b.co") },
      keychain: { [serviceForEmail("c@d.co")]: snapshotFor("c@d.co"), [keychainServiceForDir(dir)]: "live-and-rotated" },
    });
    await accountSpawnEnv("c@d.co", io);
    expect(keychain.get(keychainServiceForDir(dir))).toBe("live-and-rotated");
  });

  // Nothing to seed from is not a failure: the pane starts and asks for one login.
  it("still points at the store when there is no snapshot", async () => {
    const { io, keychain } = fakeIo({ files: { [CLAUDE_JSON]: claudeJson("a@b.co") } });
    const env = await accountSpawnEnv("c@d.co", io);
    expect(env[STORE_ENV_VAR]).toBe(accountStoreDir("c@d.co"));
    expect(keychain.size).toBe(0);
  });

  // Once an account has a store, that store owns its rotation: sending its panes back to the
  // shared slot because the default happens to match would hand them the older of two logins.
  it("keeps using a store that exists, even for the account the default slot holds", async () => {
    const dir = accountStoreDir("a@b.co");
    const { io } = fakeIo({
      files: { [CLAUDE_JSON]: claudeJson("a@b.co") },
      keychain: { [keychainServiceForDir(dir)]: "a-own-login" },
    });
    expect(await accountSpawnEnv("a@b.co", io)).toEqual({ [STORE_ENV_VAR]: dir });
  });

  // The trap this exists for: a login done in a store-carrying pane rewrites the SHARED
  // ~/.claude.json, and reading that file alone would then send this account's panes to the
  // default slot — which still holds somebody else's credentials.
  it("does not believe a claude.json that a store-carrying pane rewrote", async () => {
    const dirC = accountStoreDir("c@d.co");
    const { io } = fakeIo({
      files: { [CLAUDE_JSON]: claudeJson("c@d.co"), [INDEX]: JSON.stringify({ accounts: [], defaultAccount: "a@b.co" }) },
      keychain: { [keychainServiceForDir(dirC)]: "c-own-login" },
    });
    expect(await accountSpawnEnv("c@d.co", io)).toEqual({ [STORE_ENV_VAR]: dirC });
    // …and the account that really is in the slot still spawns without one.
    expect(await accountSpawnEnv("a@b.co", io)).toEqual({});
  });

  // No ~/.claude.json (or no oauthAccount in it) means the live identity is unknown — which
  // must not stop a named account from getting its own store.
  it("works with no identity on disk", async () => {
    const { io } = fakeIo();
    expect(await accountSpawnEnv("c@d.co", io)).toEqual({ [STORE_ENV_VAR]: accountStoreDir("c@d.co") });
  });
});
