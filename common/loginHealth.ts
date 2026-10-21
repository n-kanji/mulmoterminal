// The login-expiry watch (operator request 2026-10-21): every Claude Code login this machine
// holds — the default Keychain slot plus each per-account store — has a refresh token with a
// hard expiry (~30 days from the browser login; it does NOT move with the 8-hourly access
// token refresh, as far as observed). When it lapses, every pane on that login stops and the
// phone's Remote Control entry point goes with it, so the fix needs a person at the Mac. The
// watch exists so that person hears about it BEFORE the lapse, while they are sitting there.
//
// Shared because both sides read the report: the server scans and alerts, the toolbar chip
// shows the same slots with the same words.

import { isRecord } from "./isRecord.js";

// `expiring`: the refresh token lapses within `warnDays`. `dead`: the entry exists but its
// refresh token is empty — what the CLI writes after a refresh is refused (observed
// 2026-09-24 and 2026-10-21). `none`: no Keychain entry (a store that was never logged into,
// or the slot MT's own logout cleared) — that is a normal state, never an alert.
// `unreadable`: an entry that is not a credentials JSON (one such exists on the operator's
// machine); reported so it can be seen, never alerted on.
export type LoginSlotState = "ok" | "expiring" | "dead" | "none" | "unreadable";

export interface LoginSlot {
  // The Keychain service name — stable identity for notification dedup.
  service: string;
  // Which login this is: the shared default slot, or one account's own store.
  kind: "default" | "store";
  // The account, when known. The default slot's is MT's record of who holds it.
  email: string | null;
  state: LoginSlotState;
  // ISO timestamps, null when unknown.
  refreshExpiresAt: string | null;
  accessExpiresAt: string | null;
  // Whole days until the refresh token lapses (ceil), negative once it has. Null if unknown.
  daysLeft: number | null;
  // A short fingerprint of the refresh token, so two slots holding the SAME token can be
  // seen: that is how a login dies early (one refresh invalidates the other's copy, #2026-09-28).
  fingerprint: string | null;
}

export interface LoginHealthReport {
  checkedAt: string;
  warnDays: number;
  slots: LoginSlot[];
  // Services that share a refresh token with another slot (both listed).
  duplicates: string[];
}

export interface LoginAlertConfig {
  // Alert when a refresh token lapses within this many days.
  warnDays: number;
  // Where to post. Null = no Slack, the toolbar chip is the only surface.
  slack: { channel: string; tokenFile: string } | null;
}

export const DEFAULT_LOGIN_ALERT_WARN_DAYS = 5;
export const LOGIN_ALERT_WARN_DAYS_MIN = 1;
export const LOGIN_ALERT_WARN_DAYS_MAX = 29;

export const DEFAULT_LOGIN_ALERT: LoginAlertConfig = { warnDays: DEFAULT_LOGIN_ALERT_WARN_DAYS, slack: null };

const sanitizeWarnDays = (input: unknown): number => {
  if (typeof input !== "number" || !Number.isFinite(input)) return DEFAULT_LOGIN_ALERT_WARN_DAYS;
  return Math.min(LOGIN_ALERT_WARN_DAYS_MAX, Math.max(LOGIN_ALERT_WARN_DAYS_MIN, Math.round(input)));
};

// Both fields or nothing: a channel with no token (or the reverse) cannot post, and a
// half-configured Slack that silently never fires is exactly the failure this feature exists
// to prevent.
const sanitizeSlack = (input: unknown): LoginAlertConfig["slack"] => {
  if (!isRecord(input)) return null;
  const channel = typeof input.channel === "string" ? input.channel.trim() : "";
  const tokenFile = typeof input.tokenFile === "string" ? input.tokenFile.trim() : "";
  if (!channel || !tokenFile) return null;
  return { channel, tokenFile };
};

/** Per field, so a typo in one does not discard the other. */
export function sanitizeLoginAlert(input: unknown): LoginAlertConfig {
  if (!isRecord(input)) return { ...DEFAULT_LOGIN_ALERT };
  return { warnDays: sanitizeWarnDays(input.warnDays), slack: sanitizeSlack(input.slack) };
}

// "既定ログイン（kanji@…）" / "board@…": the slot's name wherever it is shown.
export function slotLabel(slot: LoginSlot): string {
  if (slot.kind !== "default") return slot.email ?? slot.service;
  const email = slot.email ? `（${slot.email}）` : "";
  return `既定ログイン${email}`;
}

// "（あと 3 日）" / "（今日）" / "" — the countdown, when there is one.
export function daysLeftNote(daysLeft: number | null): string {
  if (daysLeft === null) return "";
  return daysLeft <= 0 ? "（今日）" : `（あと ${daysLeft} 日）`;
}

// Which pane to run /login in: the default slot is whatever an unassigned page starts, a
// store is only reached through a page assigned to that account.
const whereToLogin = (slot: LoginSlot): string =>
  slot.kind === "default"
    ? "アカウント未割り当てのページのペインで /login してください。"
    : `${slot.email ?? "そのアカウント"} を割り当てたページのペインで /login してください。`;

// The one-line description of a slot the chip, the dropdown and the Slack post all use —
// one wording for one condition, whichever surface shows it.
export function describeSlot(slot: LoginSlot): string {
  const who = slotLabel(slot);
  const when = slot.refreshExpiresAt ? formatLocal(slot.refreshExpiresAt) : null;
  switch (slot.state) {
    case "dead":
      return `${who} のログインが切れています。${whereToLogin(slot)}`;
    case "expiring":
      return `${who} のログインが ${when ?? "まもなく"} に切れます${daysLeftNote(slot.daysLeft)}。PC の前なら今、${whereToLogin(slot)}`;
    case "ok":
      return `${who}: 期限 ${when ?? "不明"}${daysLeftNote(slot.daysLeft)}`;
    case "none":
      return `${who}: ログインなし`;
    case "unreadable":
      return `${who}: 読めない項目`;
  }
}

// "10/28 09:55" in the machine's local time — the operator reads this next to a clock.
export function formatLocal(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// The slots worth interrupting someone for, worst first.
export function alertingSlots(report: LoginHealthReport): LoginSlot[] {
  const RANK: Partial<Record<LoginSlotState, number>> = { dead: 0, expiring: 1 };
  const rank = (s: LoginSlot) => RANK[s.state] ?? 2;
  return report.slots.filter((s) => s.state === "dead" || s.state === "expiring").sort((a, b) => rank(a) - rank(b) || (a.daysLeft ?? 0) - (b.daysLeft ?? 0));
}
