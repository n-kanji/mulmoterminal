// How long ago a pane last did anything, in the three bands the status dot colours.
//
// The state word says what a pane WANTS; this says how long it has wanted it. Thirty columns
// where four say "完了・未読" look identical until you know one of them has said it since this
// morning — the operator's old iTerm2 statusline coloured exactly this, and losing it is what
// let panes rot unnoticed.
//
// `working` is exempt on purpose. A pane mid-turn is not neglected however long the turn runs,
// and ageing it would paint a long build red for doing its job. Everything else ages, including
// the states with nothing to say: an idle pane untouched for an hour is a candidate to close.
import type { PaneState } from "../../common/paneState";

export type Freshness = "fresh" | "aging" | "stale";

export const AGING_AFTER_MS = 5 * 60_000;
export const STALE_AFTER_MS = 30 * 60_000;

export function freshnessOf(state: PaneState, lastActivityAt: number | null | undefined, now: number): Freshness {
  if (state === "working") return "fresh";
  // Never reported, or a clock that puts the timestamp in the future (a restored file from a
  // machine whose clock moved): unknown age is not evidence of neglect, so it reads as fresh.
  if (typeof lastActivityAt !== "number") return "fresh";
  const age = now - lastActivityAt;
  if (age < AGING_AFTER_MS) return "fresh";
  return age < STALE_AFTER_MS ? "aging" : "stale";
}
