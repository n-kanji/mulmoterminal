import { describe, it, expect } from "vitest";
import { formatLogTimestamp, installLogTimestamps, type TimestampTarget } from "../../../server/infra/log-timestamps";

describe("formatLogTimestamp", () => {
  it("prints local time with millisecond precision and the UTC offset", () => {
    const d = new Date(2026, 8, 15, 16, 5, 45, 763);
    const out = formatLogTimestamp(d);
    const offsetMin = -d.getTimezoneOffset();
    const sign = offsetMin >= 0 ? "+" : "-";
    const abs = Math.abs(offsetMin);
    const hh = String(Math.floor(abs / 60)).padStart(2, "0");
    const mm = String(abs % 60).padStart(2, "0");
    expect(out).toBe(`2026-09-15 16:05:45.763${sign}${hh}:${mm}`);
  });

  it("zero-pads every field", () => {
    const out = formatLogTimestamp(new Date(2026, 0, 3, 4, 5, 6, 7));
    expect(out.startsWith("2026-01-03 04:05:06.007")).toBe(true);
  });
});

describe("installLogTimestamps", () => {
  function fakeConsole() {
    const calls: { method: string; args: unknown[] }[] = [];
    const target: TimestampTarget = {
      log: (...args) => calls.push({ method: "log", args }),
      info: (...args) => calls.push({ method: "info", args }),
      warn: (...args) => calls.push({ method: "warn", args }),
      error: (...args) => calls.push({ method: "error", args }),
    };
    return { target, calls };
  }

  it("prefixes each of the four methods with the timestamp and keeps the original args", () => {
    const { target, calls } = fakeConsole();
    const fixed = new Date(2026, 8, 15, 16, 5, 45, 763);
    installLogTimestamps(target, () => fixed);
    target.log("[pty] exited", 1);
    target.error("boom");
    expect(calls).toHaveLength(2);
    expect(calls[0].method).toBe("log");
    expect(calls[0].args[0]).toBe(formatLogTimestamp(fixed));
    expect(calls[0].args.slice(1)).toEqual(["[pty] exited", 1]);
    expect(calls[1].args).toEqual([formatLogTimestamp(fixed), "boom"]);
  });

  it("is idempotent: installing twice stamps a line once", () => {
    const { target, calls } = fakeConsole();
    const fixed = new Date(2026, 8, 15, 16, 5, 45, 763);
    installLogTimestamps(target, () => fixed);
    installLogTimestamps(target, () => fixed);
    target.warn("once");
    expect(calls[0].args).toEqual([formatLogTimestamp(fixed), "once"]);
  });
});
