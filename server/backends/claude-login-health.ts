// The login-expiry watch (operator request 2026-10-21) — see common/loginHealth.ts for why.
//
// What it reads: the default Keychain slot and, for every account in MT's index that has a
// store of its own, that store's Keychain entry. Never the whole Keychain — MT owns exactly
// these services and nothing else is its business. The entry is the same JSON the CLI writes
// (`claudeAiOauth.{refreshToken,refreshTokenExpiresAt,expiresAt}`), read via the injected io
// so the specs run without `security`.
//
// What it does with it: caches a report the toolbar polls, and posts to Slack (when
// configured) for a slot that is expiring or dead — once per slot per state per day, the
// dedup persisted on disk because this server restarts often and an in-memory one would
// re-post on every kickstart. Recovery (dead/expiring → ok) posts once, so the operator who
// ran /login from the chip's instruction hears that it took.
import { createHash } from "node:crypto";
import type { Express } from "express";
import os from "node:os";
import { CLAUDE_KEYCHAIN_SERVICE, normalizeEmail, parseIndex, resolveDefaultAccount } from "./claude-account.js";
import { accountStoreDir, accountStoreRoot, keychainServiceForDir, type AccountStoreIo } from "./claude-account-store.js";
import {
  alertingSlots,
  describeSlot,
  slotLabel,
  type LoginAlertConfig,
  type LoginHealthReport,
  type LoginSlot,
  type LoginSlotState,
} from "../../common/loginHealth.js";
import { isRecord } from "../../common/isRecord.js";

const DAY_MS = 86_400_000;

type Assessment = Pick<LoginSlot, "state" | "refreshExpiresAt" | "accessExpiresAt" | "daysLeft" | "fingerprint">;

const isoOrNull = (ms: unknown): string | null => (typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null);

// One Keychain value → its state. `null` (no entry) is `none`, a normal state. An entry whose
// refresh token is empty is `dead`: that is what the CLI leaves behind after the token
// endpoint refuses a refresh (observed 2026-09-24 and 2026-10-21), and the only way the
// machine is told "this login is over" before a human sees the pane.
const NO_CREDENTIAL: Assessment = { state: "none", refreshExpiresAt: null, accessExpiresAt: null, daysLeft: null, fingerprint: null };
const UNREADABLE: Assessment = { ...NO_CREDENTIAL, state: "unreadable" };

export function assessCredential(raw: string | null, now: Date, warnDays: number): Assessment {
  if (raw === null) return NO_CREDENTIAL;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return UNREADABLE;
  }
  const oauth = isRecord(parsed) && isRecord(parsed.claudeAiOauth) ? parsed.claudeAiOauth : null;
  if (!oauth) return UNREADABLE;
  const refresh = typeof oauth.refreshToken === "string" ? oauth.refreshToken : "";
  const refreshExpiresAt = isoOrNull(oauth.refreshTokenExpiresAt);
  const accessExpiresAt = isoOrNull(oauth.expiresAt);
  const fingerprint = refresh ? createHash("sha256").update(refresh).digest("hex").slice(0, 8) : null;
  const msLeft = refreshExpiresAt ? new Date(refreshExpiresAt).getTime() - now.getTime() : null;
  const daysLeft = msLeft === null ? null : Math.ceil(msLeft / DAY_MS);
  let state: LoginSlotState = "ok";
  if (!refresh || (msLeft !== null && msLeft <= 0)) state = "dead";
  else if (msLeft !== null && msLeft <= warnDays * DAY_MS) state = "expiring";
  return { state, refreshExpiresAt, accessExpiresAt, daysLeft, fingerprint };
}

// A Keychain read that throws (locked keychain, "user interaction is not allowed") marks
// THAT slot unreadable instead of aborting the scan: the other slots' answers are still
// true, and an aborted scan would leave the chip showing yesterday's report as current.
async function readSlot(io: AccountStoreIo, service: string, now: Date, warnDays: number): Promise<Assessment> {
  try {
    return assessCredential(await io.readKeychain(service), now, warnDays);
  } catch {
    return UNREADABLE;
  }
}

// Services holding the same refresh token as another slot (all of them, so a reader sees
// both sides of the pair).
function duplicateServices(slots: LoginSlot[]): string[] {
  const byFingerprint = new Map<string, string[]>();
  for (const s of slots) {
    if (!s.fingerprint) continue;
    const group = byFingerprint.get(s.fingerprint) ?? [];
    group.push(s.service);
    byFingerprint.set(s.fingerprint, group);
  }
  return [...byFingerprint.values()].filter((group) => group.length > 1).flat();
}

// Every login MT knows about, assessed. `storeRoot` is injectable for the specs only.

export async function scanLoginHealth(io: AccountStoreIo, now: Date, warnDays: number, storeRoot: string = accountStoreRoot()): Promise<LoginHealthReport> {
  // Root-aware (the specs point `storeRoot` elsewhere), otherwise accountHasStore's test.
  const hasStore = (email: string) => io.dirExists(accountStoreDir(normalizeEmail(email), storeRoot));
  const slots: LoginSlot[] = [];
  const defaultEmail = await resolveDefaultAccount(io, hasStore);
  slots.push({
    service: CLAUDE_KEYCHAIN_SERVICE,
    kind: "default",
    email: defaultEmail,
    ...(await readSlot(io, CLAUDE_KEYCHAIN_SERVICE, now, warnDays)),
  });
  for (const entry of parseIndex(await io.readFile(io.indexPath))) {
    if (!(await hasStore(entry.email))) continue;
    const service = keychainServiceForDir(accountStoreDir(entry.email, storeRoot));
    slots.push({ service, kind: "store", email: entry.email, ...(await readSlot(io, service, now, warnDays)) });
  }
  return { checkedAt: now.toISOString(), warnDays, slots, duplicates: duplicateServices(slots) };
}

// Per slot: what was last posted and on which local day, so one condition posts once a day.
export interface LoginHealthNotifyState {
  state: LoginSlotState;
  day: string;
}

const localDay = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// The Slack post: machine name first (the operator has more than one), then each alerting
// slot's line, worst first. Recovery lines are built by the monitor, not here.
export function slackText(report: LoginHealthReport, host: string): string {
  const lines = alertingSlots(report).map((s) => `- ${describeSlot(s)}`);
  const dup = report.duplicates.length
    ? [`- 注意: 同じ鍵が ${report.duplicates.length} 箇所に保存されています（片方の更新がもう片方を無効化します）: ${report.duplicates.join(", ")}`]
    : [];
  return [`[MulmoTerminal ${host}] Claude Code のログイン期限`, ...lines, ...dup].join("\n");
}

export interface LoginHealthMonitorDeps {
  io: AccountStoreIo;
  stateFile: string;
  config: () => LoginAlertConfig;
  // Post one message. Rejections are logged and swallowed — the scan and the report the
  // toolbar reads must not depend on Slack being reachable.
  notify: (text: string) => Promise<void>;
  now?: () => Date;
  host?: string;
  storeRoot?: string;
  log?: (line: string) => void;
}

export interface LoginHealthMonitor {
  run(): Promise<void>;
  latest(): LoginHealthReport | null;
  readonly io: AccountStoreIo;
}

async function readNotifyState(io: AccountStoreIo, stateFile: string): Promise<Record<string, LoginHealthNotifyState>> {
  const raw = await io.readFile(stateFile);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? (parsed as Record<string, LoginHealthNotifyState>) : {};
  } catch {
    return {};
  }
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// What to post, given the fresh report and what was last posted: alerting slots not yet
// posted today in their current state, plus slots that came back from dead/expiring.
function decide(
  report: LoginHealthReport,
  state: Record<string, LoginHealthNotifyState>,
  day: string,
  host: string,
): { alerting: LoginSlot[]; recovered: LoginSlot[]; posts: string[] } {
  const alerting = alertingSlots(report).filter((s) => {
    const prev = state[s.service];
    return !prev || prev.state !== s.state || prev.day !== day;
  });
  const recovered = report.slots.filter((s) => s.state === "ok" && state[s.service] !== undefined && state[s.service].state !== "ok");
  const posts: string[] = [];
  if (alerting.length) posts.push(slackText({ ...report, slots: alerting }, host));
  for (const s of recovered) posts.push(`[MulmoTerminal ${host}] ${slotLabel(s)} のログインが復活しました。${describeSlot(s)}`);
  return { alerting, recovered, posts };
}

export function createLoginHealthMonitor(deps: LoginHealthMonitorDeps): LoginHealthMonitor {
  const now = deps.now ?? (() => new Date());
  const host = deps.host ?? os.hostname().replace(/\.local$/, "");
  const log = deps.log ?? ((line: string) => console.warn(line));
  let latest: LoginHealthReport | null = null;

  async function scan(): Promise<LoginHealthReport | null> {
    try {
      const report = await scanLoginHealth(deps.io, now(), deps.config().warnDays, deps.storeRoot);
      for (const s of alertingSlots(report)) log(`[login-health] ${describeSlot(s)}`);
      if (report.duplicates.length) log(`[login-health] one refresh token held by several slots: ${report.duplicates.join(", ")}`);
      return report;
    } catch (e) {
      log(`[login-health] scan failed: ${errMsg(e)}`);
      return null;
    }
  }

  async function runOnce(): Promise<void> {
    const report = await scan();
    if (!report) return;
    latest = report;
    // No Slack configured: the chip is the only surface, and nothing was "posted" — so
    // nothing is recorded, and the first post after Slack is configured is not skipped as
    // already-sent-today.
    if (!deps.config().slack) return;
    const state = await readNotifyState(deps.io, deps.stateFile);
    const day = localDay(now());
    const { alerting, recovered, posts } = decide(report, state, day, host);
    if (!posts.length) return;
    // Record first, post second: a Slack outage must not turn into a post per hour once it
    // is back. One lost post a day is the cheaper failure.
    for (const s of alerting) state[s.service] = { state: s.state, day };
    for (const s of recovered) state[s.service] = { state: "ok", day };
    try {
      await deps.io.writeFile(deps.stateFile, JSON.stringify(state, null, 2));
    } catch (e) {
      log(`[login-health] could not persist notify state: ${errMsg(e)}`);
    }
    for (const text of posts) {
      try {
        await deps.notify(text);
      } catch (e) {
        log(`[login-health] notify failed: ${errMsg(e)}`);
      }
    }
  }

  // One scan at a time: the hourly timer, the startup scan and the chip's "re-check" can
  // overlap (a `security` call takes a moment), and two runs reading the same state file
  // would both post. Later callers share the in-flight run.
  let inFlight: Promise<void> | null = null;
  const run = (): Promise<void> => {
    if (!inFlight) inFlight = runOnce().finally(() => (inFlight = null));
    return inFlight;
  };

  return { run, latest: () => latest, io: deps.io };
}

// GET: the cached report (null until the first scan lands). POST: scan now — the chip's
// "re-check" after a /login, so the warning clears without waiting an hour. State-changing,
// so origin-guarded like the other claude-account routes.
export function mountLoginHealthRoutes(
  app: Express,
  monitor: LoginHealthMonitor,
  isAllowedOrigin: (origin: string | undefined, remoteAddress: string | undefined) => boolean,
): void {
  app.get("/api/claude-account/health", (_req, res) => {
    res.json({ report: monitor.latest() });
  });
  app.post("/api/claude-account/health", async (req, res) => {
    if (!isAllowedOrigin(req.headers.origin, req.socket?.remoteAddress)) return void res.status(403).json({ error: "forbidden origin" });
    await monitor.run();
    res.json({ report: monitor.latest() });
  });
}
