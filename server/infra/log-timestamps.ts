// Every server log line carries the wall-clock time it was written. Before this, server.log
// (launchd's StandardOutPath) had no timestamps at all, and the 2026-09-15 reboot audit had to
// rebuild the timeline of a kernel panic from `ps -o lstart` and the mtimes of state files.
// Local time with the UTC offset, because the operator reads the log on the machine that
// wrote it and compares it against `ps`, tmux, and macOS diagnostics — all local.
//
// Pure formatter + an installer that wraps console methods; the installer is invoked from
// install-log-timestamps.ts so that importing THIS module has no side effect (tests).

type ConsoleMethod = "log" | "info" | "warn" | "error";
const METHODS: ConsoleMethod[] = ["log", "info", "warn", "error"];

const pad = (n: number, width = 2): string => String(n).padStart(width, "0");

/** `2026-09-15 16:05:45.763+09:00` — local time, millisecond precision, UTC offset. */
export function formatLogTimestamp(date: Date): string {
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

export interface TimestampTarget {
  log: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

/** Prefix every call to the four console methods with the timestamp. Idempotent: a second
 *  install on the same target is a no-op, so a hot reload never double-stamps a line. */
export function installLogTimestamps(target: TimestampTarget, now: () => Date = () => new Date()): void {
  const marked = target as TimestampTarget & { __timestamped?: true };
  if (marked.__timestamped) return;
  for (const method of METHODS) {
    const original = target[method].bind(target);
    target[method] = (...args: unknown[]) => original(formatLogTimestamp(now()), ...args);
  }
  marked.__timestamped = true;
}
