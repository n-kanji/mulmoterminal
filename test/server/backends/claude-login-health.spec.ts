import { describe, it, expect } from "vitest";
import {
  assessCredential,
  scanLoginHealth,
  createLoginHealthMonitor,
  slackText,
  type LoginHealthNotifyState,
} from "../../../server/backends/claude-login-health.js";
import { CLAUDE_KEYCHAIN_SERVICE, serializeIndex } from "../../../server/backends/claude-account.js";
import { accountStoreDir, keychainServiceForDir, type AccountStoreIo } from "../../../server/backends/claude-account-store.js";
import { sanitizeLoginAlert, describeSlot, alertingSlots, DEFAULT_LOGIN_ALERT } from "../../../common/loginHealth.js";

const NOW = new Date("2026-10-21T13:00:00Z"); // 22:00 JST
const DAY = 86_400_000;
const CLAUDE_JSON = "/h/.claude.json";
const INDEX = "/h/.mulmoterminal/claude-accounts.json";
const ROOT = "/h/.mulmoterminal/accounts";

const creds = (o: { refresh?: string; refreshExpiresAt?: number; expiresAt?: number }) =>
  JSON.stringify({
    claudeAiOauth: {
      accessToken: "acc",
      refreshToken: o.refresh ?? "rt-1",
      expiresAt: o.expiresAt ?? NOW.getTime() + 6 * 3_600_000,
      refreshTokenExpiresAt: o.refreshExpiresAt ?? NOW.getTime() + 20 * DAY,
      subscriptionType: "max",
    },
  });

function fakeIo(seed: { keychain?: Record<string, string>; files?: Record<string, string>; dirs?: string[] } = {}) {
  const keychain = new Map(Object.entries(seed.keychain ?? {}));
  const files = new Map(Object.entries(seed.files ?? {}));
  const dirs = new Set(seed.dirs ?? []);
  const io: AccountStoreIo = {
    readKeychain: async (s) => keychain.get(s) ?? null,
    writeKeychain: async (s, v) => void keychain.set(s, v),
    deleteKeychain: async (s) => void keychain.delete(s),
    readFile: async (p) => files.get(p) ?? null,
    writeFile: async (p, d) => void files.set(p, d),
    claudeJsonPath: CLAUDE_JSON,
    indexPath: INDEX,
    now: () => NOW,
    ensureDir: async (d) => void dirs.add(d),
    dirExists: async (d) => dirs.has(d),
    removeDir: async (d) => void dirs.delete(d),
  };
  return { io, keychain, files };
}

const claudeJson = (email: string) => JSON.stringify({ oauthAccount: { emailAddress: email } });

describe("assessCredential", () => {
  it("ok when the refresh token lapses after the warn window", () => {
    const a = assessCredential(creds({}), NOW, 5);
    expect(a.state).toBe("ok");
    expect(a.daysLeft).toBe(20);
    expect(a.fingerprint).toHaveLength(8);
  });
  it("expiring inside the window, with the day count rounded up", () => {
    const a = assessCredential(creds({ refreshExpiresAt: NOW.getTime() + 4.2 * DAY }), NOW, 5);
    expect(a.state).toBe("expiring");
    expect(a.daysLeft).toBe(5);
  });
  it("expiring on the boundary day itself", () => {
    expect(assessCredential(creds({ refreshExpiresAt: NOW.getTime() + 5 * DAY }), NOW, 5).state).toBe("expiring");
    expect(assessCredential(creds({ refreshExpiresAt: NOW.getTime() + 5 * DAY + 1 }), NOW, 5).state).toBe("ok");
  });
  it("dead when the entry exists but the refresh token is empty (what the CLI leaves after a refused refresh)", () => {
    const a = assessCredential(creds({ refresh: "", refreshExpiresAt: 0 }), NOW, 5);
    expect(a.state).toBe("dead");
    expect(a.fingerprint).toBeNull();
  });
  it("dead once the expiry is in the past even with a token present", () => {
    const a = assessCredential(creds({ refreshExpiresAt: NOW.getTime() - 1 }), NOW, 5);
    expect(a.state).toBe("dead");
    expect(a.daysLeft).toBeLessThanOrEqual(0);
  });
  it("none for a missing entry — a normal state, never an alert", () => {
    expect(assessCredential(null, NOW, 5).state).toBe("none");
  });
  it("unreadable for an entry that is not a credentials JSON", () => {
    expect(assessCredential("{}", NOW, 5).state).toBe("unreadable");
    expect(assessCredential("not json", NOW, 5).state).toBe("unreadable");
  });
});

describe("scanLoginHealth", () => {
  it("lists the default slot and every indexed account that has a store, flagging a shared token", async () => {
    const boardDir = accountStoreDir("board@x.co", ROOT);
    const { io } = fakeIo({
      keychain: {
        [CLAUDE_KEYCHAIN_SERVICE]: creds({ refresh: "same" }),
        [keychainServiceForDir(boardDir)]: creds({ refresh: "same", refreshExpiresAt: NOW.getTime() + 2 * DAY }),
      },
      files: {
        [CLAUDE_JSON]: claudeJson("kanji@x.io"),
        [INDEX]: serializeIndex(
          [
            { email: "board@x.co", savedAt: "2026-09-15T00:00:00Z" },
            { email: "kanji@x.io", savedAt: "2026-09-14T00:00:00Z" },
          ],
          "kanji@x.io",
        ),
      },
      dirs: [boardDir],
    });
    const report = await scanLoginHealth(io, NOW, 5, ROOT);
    expect(report.slots.map((s) => [s.kind, s.email, s.state])).toEqual([
      ["default", "kanji@x.io", "ok"],
      ["store", "board@x.co", "expiring"],
    ]);
    expect(report.duplicates).toEqual([CLAUDE_KEYCHAIN_SERVICE, keychainServiceForDir(boardDir)]);
    expect(report.warnDays).toBe(5);
  });
  it("a live token that belongs to another account makes the slot `mismatch`; a lapsed access token or an unanswered lookup leaves it alone", async () => {
    const boardDir = accountStoreDir("board@x.co", ROOT);
    const otherDir = accountStoreDir("other@x.co", ROOT);
    const { io } = fakeIo({
      keychain: {
        [CLAUDE_KEYCHAIN_SERVICE]: creds({ refresh: "rt-default" }),
        // The 2026-10-23 shape: board@'s store, kanji@'s token inside it.
        [keychainServiceForDir(boardDir)]: creds({ refresh: "rt-board" }),
        // A store whose access token has lapsed: not asked (MT must not refresh it).
        [keychainServiceForDir(otherDir)]: creds({ refresh: "rt-other", expiresAt: NOW.getTime() - 1 }),
      },
      files: {
        [CLAUDE_JSON]: claudeJson("kanji@x.io"),
        [INDEX]: serializeIndex(
          [
            { email: "board@x.co", savedAt: "s" },
            { email: "other@x.co", savedAt: "s" },
            { email: "kanji@x.io", savedAt: "s" },
          ],
          "kanji@x.io",
        ),
      },
      dirs: [boardDir, otherDir],
    });
    const asked: string[] = [];
    const lookup = async (token: string | null, fingerprint: string | null) => {
      if (!token) return null; // what the real lookup does with a lapsed token: nothing
      asked.push(fingerprint ?? "?");
      return "Kanji@x.io"; // the issuer's answer, case and all
    };
    const report = await scanLoginHealth(io, NOW, 5, ROOT, lookup);
    expect(report.slots.map((s) => [s.email, s.state, s.holder])).toEqual([
      ["kanji@x.io", "ok", "kanji@x.io"],
      ["board@x.co", "mismatch", "kanji@x.io"],
      ["other@x.co", "ok", null],
    ]);
    expect(asked).toHaveLength(2);
    // A lookup that cannot answer never alarms — and without one wired, nothing is asked.
    const quiet = await scanLoginHealth(io, NOW, 5, ROOT, async () => null);
    expect(quiet.slots.map((s) => s.state)).toEqual(["ok", "ok", "ok"]);
    const unwired = await scanLoginHealth(io, NOW, 5, ROOT);
    expect(unwired.slots.every((s) => s.holder === null)).toBe(true);
  });
  it("a store directory with no Keychain entry is `none`, not dead", async () => {
    const boardDir = accountStoreDir("board@x.co", ROOT);
    const { io } = fakeIo({
      keychain: { [CLAUDE_KEYCHAIN_SERVICE]: creds({}) },
      files: { [CLAUDE_JSON]: claudeJson("kanji@x.io"), [INDEX]: serializeIndex([{ email: "board@x.co", savedAt: "s" }], "kanji@x.io") },
      dirs: [boardDir],
    });
    const report = await scanLoginHealth(io, NOW, 5, ROOT);
    expect(report.slots[1]).toMatchObject({ kind: "store", email: "board@x.co", state: "none" });
    expect(report.duplicates).toEqual([]);
  });
});

describe("createLoginHealthMonitor", () => {
  function setup(opts: { keychain: Record<string, string>; stateFile?: Record<string, LoginHealthNotifyState> }) {
    const { io, files } = fakeIo({
      keychain: opts.keychain,
      files: {
        [CLAUDE_JSON]: claudeJson("kanji@x.io"),
        [INDEX]: serializeIndex([], "kanji@x.io"),
        ...(opts.stateFile ? { "/h/state.json": JSON.stringify(opts.stateFile) } : {}),
      },
    });
    const posted: string[] = [];
    let now = NOW;
    const monitor = createLoginHealthMonitor({
      io,
      stateFile: "/h/state.json",
      storeRoot: ROOT,
      config: () => ({ ...DEFAULT_LOGIN_ALERT, slack: { channel: "C1", tokenFile: "/h/secrets.env" } }),
      notify: async (text) => void posted.push(text),
      now: () => now,
    });
    return { monitor, posted, files, setNow: (d: Date) => (now = d) };
  }

  it("posts once for an expiring slot, not again the same day, again the next day", async () => {
    const { monitor, posted, setNow } = setup({ keychain: { [CLAUDE_KEYCHAIN_SERVICE]: creds({ refreshExpiresAt: NOW.getTime() + 3 * DAY }) } });
    await monitor.run();
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain("既定ログイン（kanji@x.io）");
    expect(posted[0]).toContain("あと 3 日");
    await monitor.run();
    expect(posted).toHaveLength(1);
    setNow(new Date(NOW.getTime() + DAY));
    await monitor.run();
    expect(posted).toHaveLength(2);
  });

  it("a state change posts immediately even within the day, and recovery posts once", async () => {
    const { monitor, posted, files } = setup({ keychain: { [CLAUDE_KEYCHAIN_SERVICE]: creds({ refreshExpiresAt: NOW.getTime() + 3 * DAY }) } });
    await monitor.run();
    files.set("/h/.claude.json", claudeJson("kanji@x.io"));
    // The CLI wipes the token after a refused refresh.
    const io = monitor.io;
    await io.writeKeychain(CLAUDE_KEYCHAIN_SERVICE, creds({ refresh: "", refreshExpiresAt: 0 }));
    await monitor.run();
    expect(posted).toHaveLength(2);
    expect(posted[1]).toContain("切れています");
    // A fresh /login.
    await io.writeKeychain(CLAUDE_KEYCHAIN_SERVICE, creds({ refresh: "new", refreshExpiresAt: NOW.getTime() + 30 * DAY }));
    await monitor.run();
    expect(posted).toHaveLength(3);
    expect(posted[2]).toContain("復活");
    await monitor.run();
    expect(posted).toHaveLength(3);
  });

  it("silent for ok / none slots, and the dedup survives a restart via the state file", async () => {
    const first = setup({ keychain: { [CLAUDE_KEYCHAIN_SERVICE]: creds({ refreshExpiresAt: NOW.getTime() + 3 * DAY }) } });
    await first.monitor.run();
    const persisted = JSON.parse(first.files.get("/h/state.json") ?? "{}") as Record<string, LoginHealthNotifyState>;
    const second = setup({ keychain: { [CLAUDE_KEYCHAIN_SERVICE]: creds({ refreshExpiresAt: NOW.getTime() + 3 * DAY }) }, stateFile: persisted });
    await second.monitor.run();
    expect(second.posted).toHaveLength(0);
    const quiet = setup({ keychain: { [CLAUDE_KEYCHAIN_SERVICE]: creds({}) } });
    await quiet.monitor.run();
    expect(quiet.posted).toHaveLength(0);
    expect(quiet.monitor.latest()?.slots[0].state).toBe("ok");
  });

  it("without Slack configured nothing is recorded, so configuring it later posts the same day", async () => {
    const { io, files } = fakeIo({
      keychain: { [CLAUDE_KEYCHAIN_SERVICE]: creds({ refreshExpiresAt: NOW.getTime() + 2 * DAY }) },
      files: { [CLAUDE_JSON]: claudeJson("k@x") },
    });
    const posted: string[] = [];
    let slack: { channel: string; tokenFile: string } | null = null;
    const monitor = createLoginHealthMonitor({
      io,
      stateFile: "/h/state.json",
      storeRoot: ROOT,
      config: () => ({ warnDays: 5, slack }),
      notify: async (t) => void posted.push(t),
      now: () => NOW,
    });
    await monitor.run();
    expect(monitor.latest()?.slots[0].state).toBe("expiring");
    expect(files.has("/h/state.json")).toBe(false);
    slack = { channel: "C1", tokenFile: "/f" };
    await monitor.run();
    expect(posted).toHaveLength(1);
  });

  it("overlapping runs share one scan, so a re-check during the hourly scan cannot double-post", async () => {
    const { io } = fakeIo({
      keychain: { [CLAUDE_KEYCHAIN_SERVICE]: creds({ refreshExpiresAt: NOW.getTime() + 2 * DAY }) },
      files: { [CLAUDE_JSON]: claudeJson("k@x") },
    });
    const posted: string[] = [];
    const monitor = createLoginHealthMonitor({
      io,
      stateFile: "/h/state.json",
      storeRoot: ROOT,
      config: () => ({ warnDays: 5, slack: { channel: "C1", tokenFile: "/f" } }),
      notify: async (t) => void posted.push(t),
      now: () => NOW,
    });
    await Promise.all([monitor.run(), monitor.run(), monitor.run()]);
    expect(posted).toHaveLength(1);
  });

  it("a Keychain read that throws marks that slot unreadable and keeps the rest", async () => {
    const boardDir = accountStoreDir("board@x.co", ROOT);
    const { io } = fakeIo({
      keychain: { [CLAUDE_KEYCHAIN_SERVICE]: creds({}) },
      files: { [CLAUDE_JSON]: claudeJson("kanji@x.io"), [INDEX]: serializeIndex([{ email: "board@x.co", savedAt: "s" }], "kanji@x.io") },
      dirs: [boardDir],
    });
    const throwing: AccountStoreIo = {
      ...io,
      readKeychain: async (s) => (s === CLAUDE_KEYCHAIN_SERVICE ? io.readKeychain(s) : Promise.reject(new Error("User interaction is not allowed"))),
    };
    const report = await scanLoginHealth(throwing, NOW, 5, ROOT);
    expect(report.slots.map((s) => s.state)).toEqual(["ok", "unreadable"]);
  });

  it("asks who a token belongs to once per refresh token, not once per scan, and a mismatch posts like any alert", async () => {
    const boardDir = accountStoreDir("board@x.co", ROOT);
    const { io, keychain } = fakeIo({
      keychain: { [CLAUDE_KEYCHAIN_SERVICE]: creds({ refresh: "rt-default" }), [keychainServiceForDir(boardDir)]: creds({ refresh: "rt-board" }) },
      files: { [CLAUDE_JSON]: claudeJson("kanji@x.io"), [INDEX]: serializeIndex([{ email: "board@x.co", savedAt: "s" }], "kanji@x.io") },
      dirs: [boardDir],
    });
    let asked = 0;
    const posts: string[] = [];
    const monitor = createLoginHealthMonitor({
      io,
      stateFile: "/h/state.json",
      config: () => ({ warnDays: 5, slack: { channel: "C1", tokenFile: "/f" } }),
      notify: async (t) => void posts.push(t),
      lookupHolder: async (token) => {
        if (!token) return null;
        asked += 1;
        return "kanji@x.io";
      },
      holdersFile: "/h/holders.json",
      now: () => NOW,
      host: "mac",
      storeRoot: ROOT,
    });
    await monitor.run();
    await monitor.run();
    expect(asked).toBe(2); // two slots, two tokens — the second scan hit the cache
    expect(monitor.latest()?.slots.map((s) => s.state)).toEqual(["ok", "mismatch"]);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain("board@x.co に保存されているログインの中身は kanji@x.io");
    // The board pane goes idle and its access token lapses: the endpoint cannot be asked, but
    // the owner is still known from the cache — so the slot stays a mismatch, and nothing
    // posts (the review finding of 2026-10-24: this used to read as "recovered").
    keychain.set(keychainServiceForDir(boardDir), creds({ refresh: "rt-board", expiresAt: NOW.getTime() - 1 }));
    await monitor.run();
    expect(asked).toBe(2);
    expect(monitor.latest()?.slots[1]).toMatchObject({ state: "mismatch", holder: "kanji@x.io" });
    expect(posts).toHaveLength(1);
    // A server restart with the same lapsed token: the cache comes back from disk.
    let askedAfterRestart = 0;
    const restarted = createLoginHealthMonitor({
      io,
      stateFile: "/h/state.json",
      holdersFile: "/h/holders.json",
      config: () => ({ warnDays: 5, slack: { channel: "C1", tokenFile: "/f" } }),
      notify: async (t) => void posts.push(t),
      lookupHolder: async () => {
        askedAfterRestart += 1;
        return null;
      },
      now: () => NOW,
      host: "mac",
      storeRoot: ROOT,
    });
    await restarted.run();
    expect(askedAfterRestart).toBe(0);
    expect(restarted.latest()?.slots[1].state).toBe("mismatch");
    expect(posts).toHaveLength(1);
    // The operator logs in again, properly: a new refresh token is a new question, and the
    // confirmed owner is what ends the alert — with its own wording, since nothing "came back".
    keychain.set(keychainServiceForDir(boardDir), creds({ refresh: "rt-board-2" }));
    let fixed = 0;
    const fixedMonitor = createLoginHealthMonitor({
      io,
      stateFile: "/h/state.json",
      holdersFile: "/h/holders.json",
      config: () => ({ warnDays: 5, slack: { channel: "C1", tokenFile: "/f" } }),
      notify: async (t) => void posts.push(t),
      lookupHolder: async (token) => {
        if (!token) return null;
        fixed += 1;
        return "board@x.co";
      },
      now: () => NOW,
      host: "mac",
      storeRoot: ROOT,
    });
    await fixedMonitor.run();
    expect(fixed).toBe(1);
    expect(fixedMonitor.latest()?.slots[1]).toMatchObject({ state: "ok", holder: "board@x.co" });
    expect(posts).toHaveLength(2);
    expect(posts[1]).toContain("board@x.co の名義が正しくなりました（中身も board@x.co）");
  });
  it("a Slack failure does not break the scan, and the report is still served", async () => {
    const { io } = fakeIo({
      keychain: { [CLAUDE_KEYCHAIN_SERVICE]: creds({ refreshExpiresAt: NOW.getTime() + DAY }) },
      files: { [CLAUDE_JSON]: claudeJson("k@x") },
    });
    const monitor = createLoginHealthMonitor({
      io,
      stateFile: "/h/state.json",
      storeRoot: ROOT,
      config: () => DEFAULT_LOGIN_ALERT,
      notify: async () => {
        throw new Error("slack down");
      },
      now: () => NOW,
    });
    await expect(monitor.run()).resolves.toBeUndefined();
    expect(monitor.latest()?.slots[0].state).toBe("expiring");
  });
});

describe("wording and config", () => {
  it("slackText names the machine and every alerting slot, worst first", () => {
    const text = slackText(
      {
        checkedAt: NOW.toISOString(),
        warnDays: 5,
        duplicates: [],
        slots: [
          {
            service: "a",
            kind: "store",
            email: "b@x",
            state: "expiring",
            refreshExpiresAt: new Date(NOW.getTime() + 2 * DAY).toISOString(),
            accessExpiresAt: null,
            daysLeft: 2,
            fingerprint: "x",
            holder: null,
          },
          {
            service: "d",
            kind: "default",
            email: "k@x",
            state: "dead",
            refreshExpiresAt: null,
            accessExpiresAt: null,
            daysLeft: null,
            fingerprint: null,
            holder: null,
          },
        ],
      },
      "mbp",
    );
    expect(text.indexOf("切れています")).toBeLessThan(text.indexOf("切れます"));
    expect(text).toContain("mbp");
  });
  it("describeSlot says where to /login for each kind", () => {
    expect(
      describeSlot({
        service: "s",
        kind: "default",
        email: "k@x",
        state: "dead",
        refreshExpiresAt: null,
        accessExpiresAt: null,
        daysLeft: null,
        fingerprint: null,
        holder: null,
      }),
    ).toContain("未割り当て");
    expect(
      describeSlot({
        service: "s",
        kind: "store",
        email: "b@x",
        state: "expiring",
        refreshExpiresAt: NOW.toISOString(),
        accessExpiresAt: null,
        daysLeft: 1,
        fingerprint: "f",
        holder: null,
      }),
    ).toContain("b@x を割り当てた");
    // A mismatch names who the token really belongs to and says to fix the BROWSER first —
    // that is the half that went wrong on 09-28 and 10-23.
    const mismatch = describeSlot({
      service: "s",
      kind: "store",
      email: "b@x",
      state: "mismatch",
      refreshExpiresAt: NOW.toISOString(),
      accessExpiresAt: null,
      daysLeft: 20,
      fingerprint: "f",
      holder: "k@x",
    });
    expect(mismatch).toContain("中身は k@x");
    expect(mismatch).toContain("ブラウザの claude.ai を b@x に切り替えてから");
    expect(mismatch).toContain("b@x を割り当てた");
  });
  it("alertingSlots drops ok/none/unreadable and puts mismatch, then dead, first", () => {
    const mk = (state: "ok" | "dead" | "expiring" | "none" | "unreadable" | "mismatch", daysLeft: number | null) => ({
      service: state,
      kind: "store" as const,
      email: null,
      state,
      refreshExpiresAt: null,
      accessExpiresAt: null,
      daysLeft,
      fingerprint: null,
      holder: null,
    });
    const out = alertingSlots({
      checkedAt: "",
      warnDays: 5,
      duplicates: [],
      slots: [mk("ok", 20), mk("expiring", 4), mk("none", null), mk("dead", -1), mk("mismatch", 20), mk("expiring", 1), mk("unreadable", null)],
    });
    expect(out.map((s) => [s.state, s.daysLeft])).toEqual([
      ["mismatch", 20],
      ["dead", -1],
      ["expiring", 1],
      ["expiring", 4],
    ]);
  });
  it("sanitizeLoginAlert clamps warnDays and needs both Slack fields", () => {
    expect(sanitizeLoginAlert(undefined)).toEqual(DEFAULT_LOGIN_ALERT);
    expect(sanitizeLoginAlert({ warnDays: 99 }).warnDays).toBe(29);
    expect(sanitizeLoginAlert({ warnDays: 0 }).warnDays).toBe(1);
    expect(sanitizeLoginAlert({ warnDays: "x", slack: { channel: "C1" } })).toEqual(DEFAULT_LOGIN_ALERT);
    expect(sanitizeLoginAlert({ slack: { channel: " C1 ", tokenFile: "/f" } }).slack).toEqual({ channel: "C1", tokenFile: "/f" });
  });
});
