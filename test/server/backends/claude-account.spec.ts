// @vitest-environment node
// The toolbar's Claude account switcher. Everything runs against an in-memory IO seam —
// no real Keychain, no ~/.claude.json, no API keys.
import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";

import {
  mountClaudeAccountRoutes,
  serviceForEmail,
  withOauthAccount,
  readOauthAccount,
  emailOf,
  parseIndex,
  upsertIndexEntry,
  parseSnapshot,
  CLAUDE_KEYCHAIN_SERVICE,
  type ClaudeAccountIo,
} from "../../../server/backends/claude-account.js";

const CLAUDE_JSON = "/home/.claude.json";
const INDEX = "/home/.mulmoterminal/claude-accounts.json";

// In-memory IO: `keychain` and `files` are plain maps the tests inspect afterwards.
function fakeIo(seed: { keychain?: Record<string, string>; files?: Record<string, string> } = {}) {
  const keychain = new Map(Object.entries(seed.keychain ?? {}));
  const files = new Map(Object.entries(seed.files ?? {}));
  const io: ClaudeAccountIo = {
    readKeychain: async (s) => keychain.get(s) ?? null,
    writeKeychain: async (s, v) => void keychain.set(s, v),
    deleteKeychain: async (s) => void keychain.delete(s),
    readFile: async (p) => files.get(p) ?? null,
    writeFile: async (p, d) => void files.set(p, d),
    claudeJsonPath: CLAUDE_JSON,
    indexPath: INDEX,
    now: () => new Date("2026-08-22T00:00:00Z"),
  };
  return { io, keychain, files };
}

const claudeJson = (email: string) => JSON.stringify({ oauthAccount: { emailAddress: email, organizationRole: "admin" }, otherState: { keep: true } });

const snapshotFor = (email: string, credentials = `creds-${email}`) =>
  JSON.stringify({ credentials, oauthAccount: { emailAddress: email }, savedAt: "2026-08-01T00:00:00Z" });

const appWith = (io: ClaudeAccountIo, allowOrigin = true, restartPanes?: () => number) => {
  const app = express();
  app.use(express.json());
  mountClaudeAccountRoutes(app, { isAllowedOrigin: () => allowOrigin, restartPanes }, io);
  return app;
};

describe("pure helpers", () => {
  it("serviceForEmail normalizes case and whitespace", () => {
    expect(serviceForEmail("  A@B.co ")).toBe("MulmoTerminal-claude-account:a@b.co");
  });

  it("withOauthAccount replaces only the oauthAccount key", () => {
    const out = JSON.parse(withOauthAccount(claudeJson("a@b.co"), { emailAddress: "x@y.z" }));
    expect(out.oauthAccount.emailAddress).toBe("x@y.z");
    expect(out.otherState).toEqual({ keep: true });
  });

  it("withOauthAccount(null) removes the key and keeps the rest", () => {
    const out = JSON.parse(withOauthAccount(claudeJson("a@b.co"), null));
    expect(out.oauthAccount).toBeUndefined();
    expect(out.otherState).toEqual({ keep: true });
  });

  it("withOauthAccount throws on unparseable input rather than clobbering the file", () => {
    expect(() => withOauthAccount("not json", { a: 1 })).toThrow();
  });

  it("readOauthAccount/emailOf tolerate garbage", () => {
    expect(readOauthAccount(null)).toBeNull();
    expect(readOauthAccount("nope")).toBeNull();
    expect(emailOf(null)).toBeNull();
    expect(emailOf({ emailAddress: 42 })).toBeNull();
    expect(emailOf({ emailAddress: " A@B.co " })).toBe("a@b.co");
  });

  it("parseIndex drops malformed entries; upsert replaces by email and sorts", () => {
    expect(parseIndex(null)).toEqual([]);
    expect(parseIndex("broken")).toEqual([]);
    const idx = parseIndex(JSON.stringify({ accounts: [{ email: "b@x.co", savedAt: "t1" }, { bad: true }] }));
    expect(idx).toEqual([{ email: "b@x.co", savedAt: "t1" }]);
    const up = upsertIndexEntry(upsertIndexEntry(idx, "a@x.co", "t2"), "B@x.co", "t3");
    expect(up).toEqual([
      { email: "a@x.co", savedAt: "t2" },
      { email: "b@x.co", savedAt: "t3" },
    ]);
  });

  it("parseSnapshot requires a credentials string", () => {
    expect(parseSnapshot(null)).toBeNull();
    expect(parseSnapshot(JSON.stringify({ oauthAccount: {} }))).toBeNull();
    expect(parseSnapshot(snapshotFor("a@b.co"))?.credentials).toBe("creds-a@b.co");
  });
});

describe("GET /api/claude-account", () => {
  it("reports the live identity and the stored list, and never the tokens", async () => {
    const { io } = fakeIo({
      keychain: { [CLAUDE_KEYCHAIN_SERVICE]: "live-secret" },
      files: {
        [CLAUDE_JSON]: claudeJson("Board@orosy.co.jp"),
        [INDEX]: JSON.stringify({ accounts: [{ email: "second@orosy.co.jp", savedAt: "t" }] }),
      },
    });
    const res = await request(appWith(io)).get("/api/claude-account");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ current: "board@orosy.co.jp", accounts: [{ email: "second@orosy.co.jp", savedAt: "t" }] });
    expect(JSON.stringify(res.body)).not.toContain("live-secret");
  });

  it("answers null/[] when nothing is logged in or stored", async () => {
    const res = await request(appWith(fakeIo().io)).get("/api/claude-account");
    expect(res.body).toEqual({ current: null, accounts: [] });
  });
});

describe("POST /api/claude-account/switch", () => {
  it("saves the outgoing account, restores the target, and rewrites oauthAccount only", async () => {
    const { io, keychain, files } = fakeIo({
      keychain: {
        [CLAUDE_KEYCHAIN_SERVICE]: "live-creds-of-a",
        [serviceForEmail("b@x.co")]: snapshotFor("b@x.co", "stored-creds-of-b"),
      },
      files: { [CLAUDE_JSON]: claudeJson("a@x.co") },
    });
    const res = await request(appWith(io)).post("/api/claude-account/switch").send({ email: "b@x.co" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, current: "b@x.co", restartedPanes: 0 });
    // live slot now holds b's credentials
    expect(keychain.get(CLAUDE_KEYCHAIN_SERVICE)).toBe("stored-creds-of-b");
    // a's live pair was snapshotted before the overwrite
    const saved = parseSnapshot(keychain.get(serviceForEmail("a@x.co")) ?? null);
    expect(saved?.credentials).toBe("live-creds-of-a");
    expect(saved?.oauthAccount?.emailAddress).toBe("a@x.co");
    // claude.json identity followed the credentials; unrelated state survived
    const written = JSON.parse(files.get(CLAUDE_JSON) ?? "{}");
    expect(written.oauthAccount.emailAddress).toBe("b@x.co");
    expect(written.otherState).toEqual({ keep: true });
    // both accounts are now listed
    expect(parseIndex(files.get(INDEX) ?? null).map((e) => e.email)).toEqual(["a@x.co", "b@x.co"]);
  });

  it("is a no-op when the target is already current", async () => {
    const { io, keychain } = fakeIo({
      keychain: { [CLAUDE_KEYCHAIN_SERVICE]: "live" },
      files: { [CLAUDE_JSON]: claudeJson("a@x.co") },
    });
    const res = await request(appWith(io)).post("/api/claude-account/switch").send({ email: "A@x.co" });
    expect(res.body).toEqual({ ok: true, current: "a@x.co" });
    expect(keychain.get(CLAUDE_KEYCHAIN_SERVICE)).toBe("live");
    expect(keychain.has(serviceForEmail("a@x.co"))).toBe(false);
  });

  it("404s (and changes nothing) when the target was never snapshotted", async () => {
    const { io, keychain } = fakeIo({
      keychain: { [CLAUDE_KEYCHAIN_SERVICE]: "live" },
      files: { [CLAUDE_JSON]: claudeJson("a@x.co") },
    });
    const res = await request(appWith(io)).post("/api/claude-account/switch").send({ email: "nobody@x.co" });
    expect(res.status).toBe(404);
    expect(keychain.get(CLAUDE_KEYCHAIN_SERVICE)).toBe("live");
  });

  it("still restores the target when nothing is currently logged in", async () => {
    const { io, keychain } = fakeIo({
      keychain: { [serviceForEmail("b@x.co")]: snapshotFor("b@x.co") },
      files: { [CLAUDE_JSON]: JSON.stringify({ otherState: 1 }) },
    });
    const res = await request(appWith(io)).post("/api/claude-account/switch").send({ email: "b@x.co" });
    expect(res.status).toBe(200);
    expect(keychain.get(CLAUDE_KEYCHAIN_SERVICE)).toBe("creds-b@x.co");
  });

  it("rejects a missing email and a forbidden origin", async () => {
    const { io } = fakeIo();
    expect((await request(appWith(io)).post("/api/claude-account/switch").send({})).status).toBe(400);
    expect((await request(appWith(io, false)).post("/api/claude-account/switch").send({ email: "b@x.co" })).status).toBe(403);
  });
});

describe("pane restarts", () => {
  const switchable = () =>
    fakeIo({
      keychain: {
        [CLAUDE_KEYCHAIN_SERVICE]: "live-creds-of-a",
        [serviceForEmail("b@x.co")]: snapshotFor("b@x.co"),
      },
      files: { [CLAUDE_JSON]: claudeJson("a@x.co") },
    });

  it("switch restarts the fleet only when asked, AFTER the swap, and reports the count", async () => {
    const { io, keychain } = switchable();
    const restartPanes = vi.fn(() => {
      // Restart must see the swapped credentials — a pane resumed before the swap would
      // come back on the OLD account.
      expect(keychain.get(CLAUDE_KEYCHAIN_SERVICE)).toBe("creds-b@x.co");
      return 3;
    });
    const res = await request(appWith(io, true, restartPanes))
      .post("/api/claude-account/switch")
      .send({ email: "b@x.co", restartPanes: true });
    expect(res.body).toEqual({ ok: true, current: "b@x.co", restartedPanes: 3 });
    expect(restartPanes).toHaveBeenCalledOnce();
  });

  it("switch without the flag, a no-op switch, and a failed switch never restart", async () => {
    const restartPanes = vi.fn(() => 3);
    const { io } = switchable();
    // Order matters against the shared io: the no-op (a@x.co IS current) and the 404 first,
    // then a real switch with the flag absent.
    await request(appWith(io, true, restartPanes))
      .post("/api/claude-account/switch")
      .send({ email: "a@x.co", restartPanes: true });
    await request(appWith(io, true, restartPanes))
      .post("/api/claude-account/switch")
      .send({ email: "nobody@x.co", restartPanes: true });
    await request(appWith(io, true, restartPanes))
      .post("/api/claude-account/switch")
      .send({ email: "b@x.co" });
    expect(restartPanes).not.toHaveBeenCalled();
  });

  it("POST /restart-panes restarts on the current account; 0 when unavailable; origin-guarded", async () => {
    const { io } = switchable();
    const restartPanes = vi.fn(() => 2);
    const res = await request(appWith(io, true, restartPanes))
      .post("/api/claude-account/restart-panes")
      .send({});
    expect(res.body).toEqual({ ok: true, restartedPanes: 2 });
    const bare = await request(appWith(io)).post("/api/claude-account/restart-panes").send({});
    expect(bare.body).toEqual({ ok: true, restartedPanes: 0 });
    expect(
      (
        await request(appWith(io, false, restartPanes))
          .post("/api/claude-account/restart-panes")
          .send({})
      ).status,
    ).toBe(403);
  });
});

describe("POST /api/claude-account/logout", () => {
  it("snapshots the current login, then clears the live slots", async () => {
    const { io, keychain, files } = fakeIo({
      keychain: { [CLAUDE_KEYCHAIN_SERVICE]: "live-creds" },
      files: { [CLAUDE_JSON]: claudeJson("a@x.co") },
    });
    const res = await request(appWith(io)).post("/api/claude-account/logout").send({});
    expect(res.body).toEqual({ ok: true, current: null });
    expect(keychain.has(CLAUDE_KEYCHAIN_SERVICE)).toBe(false);
    expect(parseSnapshot(keychain.get(serviceForEmail("a@x.co")) ?? null)?.credentials).toBe("live-creds");
    expect(JSON.parse(files.get(CLAUDE_JSON) ?? "{}").oauthAccount).toBeUndefined();
  });

  it("is a no-op when already logged out", async () => {
    const res = await request(appWith(fakeIo().io)).post("/api/claude-account/logout").send({});
    expect(res.body).toEqual({ ok: true, current: null });
  });

  it("refuses to log out credentials it cannot attribute to an account", async () => {
    const { io, keychain } = fakeIo({
      keychain: { [CLAUDE_KEYCHAIN_SERVICE]: "live-creds" },
      files: { [CLAUDE_JSON]: JSON.stringify({ otherState: 1 }) },
    });
    const res = await request(appWith(io)).post("/api/claude-account/logout").send({});
    expect(res.status).toBe(409);
    expect(keychain.get(CLAUDE_KEYCHAIN_SERVICE)).toBe("live-creds");
  });
});
