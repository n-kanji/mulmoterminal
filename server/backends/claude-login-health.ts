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

// The access token inside a credentials JSON, for asking who it belongs to. Null when absent
// or when it has already lapsed: a lapsed one would be refused, and MT must NOT refresh it —
// a refresh rotates the token under the running pane's feet (see claude-account-store.ts).
function liveAccessToken(raw: string | null, now: Date): string | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    const oauth = isRecord(parsed) && isRecord(parsed.claudeAiOauth) ? parsed.claudeAiOauth : null;
    if (!oauth || typeof oauth.accessToken !== "string" || !oauth.accessToken) return null;
    const expiresAt = typeof oauth.expiresAt === "number" ? oauth.expiresAt : 0;
    return expiresAt > now.getTime() ? oauth.accessToken : null;
  } catch {
    return null;
  }
}

// "Whose token is this?" — answered by the OAuth profile endpoint, the only party that knows.
// `fingerprint` (of the refresh token) is passed so a caller can cache: the answer cannot
// change while the fingerprint does not. `accessToken` is null when there is no LIVE one
// (lapsed, ~8h after the pane last refreshed) — then only a cache can answer, and the
// endpoint must not be asked. Null means "could not tell", never "nobody": the scan then
// leaves the slot as it was, because a network blip must not raise a false alarm.
export type HolderLookup = (accessToken: string | null, fingerprint: string | null) => Promise<string | null>;
export const NO_HOLDER_LOOKUP: HolderLookup = async () => null;

const normalizeOrNull = (email: string | null | undefined): string | null => (email ? normalizeEmail(email) : null);

const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
// The lookup the server wires in. Specs never reach it: they pass their own (or none).
export const profileHolderLookup: HolderLookup = async (accessToken) => {
  if (!accessToken) return null;
  try {
    const res = await fetch(PROFILE_URL, {
      headers: { Authorization: `Bearer ${accessToken}`, "anthropic-beta": "oauth-2025-04-20" },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    const account = isRecord(body) && isRecord(body.account) ? body.account : null;
    return normalizeOrNull(account && typeof account.email === "string" ? account.email : null);
  } catch {
    // a network blip is "could not tell", not an alarm
    return null;
  }
};

// A Keychain read that throws (locked keychain, "user interaction is not allowed") marks
// THAT slot unreadable instead of aborting the scan: the other slots' answers are still
// true, and an aborted scan would leave the chip showing yesterday's report as current.
//
// A slot that is alive and names an account is then asked who its token belongs to; an
// answer naming someone else turns it into `mismatch`. Asked even without a live access
// token: the lookup may know the answer from the fingerprint, and a mismatch whose token
// lapsed overnight must not read as "recovered" (observed in review 2026-10-24).
type SlotReading = Assessment & { holder: string | null };

async function readSlot(
  io: AccountStoreIo,
  service: string,
  email: string | null,
  now: Date,
  warnDays: number,
  lookupHolder: HolderLookup,
): Promise<SlotReading> {
  let raw: string | null;
  try {
    raw = await io.readKeychain(service);
  } catch {
    return { ...UNREADABLE, holder: null };
  }
  const assessment = assessCredential(raw, now, warnDays);
  if (assessment.state !== "ok" && assessment.state !== "expiring") return { ...assessment, holder: null };
  const holder = normalizeOrNull(await lookupHolder(liveAccessToken(raw, now), assessment.fingerprint));
  const expected = normalizeOrNull(email);
  if (holder && expected && holder !== expected) return { ...assessment, state: "mismatch", holder };
  return { ...assessment, holder };
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

// Every login MT knows about, assessed. `storeRoot` is injectable for the specs only; the
// holder lookup defaults to "don't ask" so nothing here touches the network unless wired.

export async function scanLoginHealth(
  io: AccountStoreIo,
  now: Date,
  warnDays: number,
  storeRoot: string = accountStoreRoot(),
  lookupHolder: HolderLookup = NO_HOLDER_LOOKUP,
): Promise<LoginHealthReport> {
  // Root-aware (the specs point `storeRoot` elsewhere), otherwise accountHasStore's test.
  const hasStore = (email: string) => io.dirExists(accountStoreDir(normalizeEmail(email), storeRoot));
  const read = (service: string, email: string | null) => readSlot(io, service, email, now, warnDays, lookupHolder);
  const slots: LoginSlot[] = [];
  const defaultEmail = await resolveDefaultAccount(io, hasStore);
  slots.push({ service: CLAUDE_KEYCHAIN_SERVICE, kind: "default", email: defaultEmail, ...(await read(CLAUDE_KEYCHAIN_SERVICE, defaultEmail)) });
  for (const entry of parseIndex(await io.readFile(io.indexPath))) {
    if (!(await hasStore(entry.email))) continue;
    const service = keychainServiceForDir(accountStoreDir(entry.email, storeRoot));
    slots.push({ service, kind: "store", email: entry.email, ...(await read(service, entry.email)) });
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
  // Who a token belongs to (profileHolderLookup in the server). Default: never asked, so a
  // monitor built without it — every spec — stays off the network. Answers are cached per
  // refresh-token fingerprint, so the hourly scan asks once per login, not once per hour.
  lookupHolder?: HolderLookup;
  // Where that cache persists (fingerprint → email, no secrets). This server restarts on
  // every deploy, and a mismatch whose token has since lapsed can only be re-asserted from
  // here — without it a restart turns the red chip green until the next refresh.
  holdersFile?: string;
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
  // Back to `ok` after an alert. After a MISMATCH only a CONFIRMED owner counts: an `ok` with
  // no answer (lapsed token, endpoint down, restart with no cache) is "could not tell", and
  // posting "fixed" on that would have the chip flip red/green with every token lapse.
  const ownerConfirmed = (s: LoginSlot) => s.holder !== null && s.holder === normalizeOrNull(s.email);
  const recovered = report.slots.filter((s) => {
    const prev = state[s.service];
    if (s.state !== "ok" || !prev || prev.state === "ok") return false;
    return prev.state !== "mismatch" || ownerConfirmed(s);
  });
  const posts: string[] = [];
  if (alerting.length) posts.push(slackText({ ...report, slots: alerting }, host));
  for (const s of recovered) {
    const what = state[s.service]?.state === "mismatch" ? `の名義が正しくなりました（中身も ${s.holder}）` : "のログインが復活しました";
    posts.push(`[MulmoTerminal ${host}] ${slotLabel(s)} ${what}。${describeSlot(s)}`);
  }
  return { alerting, recovered, posts };
}

// Holder answers by refresh-token fingerprint. A token's owner cannot change while its
// fingerprint does not, and a fingerprint that is gone (rotated) is never asked about again,
// so the map is cleared when it grows past a few rotations' worth. The cache is consulted
// BEFORE the token is looked at: a lapsed token cannot be asked about, but its owner is still
// known. `holdersFile` (fingerprint → email, no secrets) carries it across server restarts.
function holderCache(io: AccountStoreIo, holdersFile: string | undefined, lookup: HolderLookup, log: (line: string) => void): HolderLookup {
  const holders = new Map<string, string>();
  let loaded = false;
  async function load(): Promise<void> {
    loaded = true;
    if (!holdersFile) return;
    try {
      const parsed: unknown = JSON.parse((await io.readFile(holdersFile)) ?? "{}");
      if (!isRecord(parsed)) return;
      for (const [fingerprint, email] of Object.entries(parsed)) if (typeof email === "string" && email) holders.set(fingerprint, email);
    } catch {
      // unreadable cache: start empty, the next answers rebuild it
    }
  }
  async function save(): Promise<void> {
    if (!holdersFile) return;
    try {
      await io.writeFile(holdersFile, JSON.stringify(Object.fromEntries(holders), null, 2));
    } catch (e) {
      log(`[login-health] could not persist the token-owner cache: ${errMsg(e)}`);
    }
  }
  return async (token, fingerprint) => {
    if (!loaded) await load();
    const known = fingerprint ? holders.get(fingerprint) : undefined;
    if (known) return known;
    if (!token) return null;
    const holder = await lookup(token, fingerprint);
    if (holder && fingerprint) {
      if (holders.size >= 64) holders.clear();
      holders.set(fingerprint, holder);
      await save();
    }
    return holder;
  };
}

export function createLoginHealthMonitor(deps: LoginHealthMonitorDeps): LoginHealthMonitor {
  const now = deps.now ?? (() => new Date());
  const host = deps.host ?? os.hostname().replace(/\.local$/, "");
  const log = deps.log ?? ((line: string) => console.warn(line));
  let latest: LoginHealthReport | null = null;

  const cachedLookup = holderCache(deps.io, deps.holdersFile, deps.lookupHolder ?? NO_HOLDER_LOOKUP, log);

  async function scan(): Promise<LoginHealthReport | null> {
    try {
      const report = await scanLoginHealth(deps.io, now(), deps.config().warnDays, deps.storeRoot, cachedLookup);
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
