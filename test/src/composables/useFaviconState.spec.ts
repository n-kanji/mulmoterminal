import { describe, it, expect } from "vitest";
import { countWaiting, deriveFaviconState, titleWithCount } from "../../../src/composables/useFaviconState";
import { badgeText } from "../../../src/composables/useDynamicFavicon";

const a = (working: boolean, waiting: boolean) => ({ working, waiting });
// The badge counts what BLOCKS, so it needs the hook that set the state, not just the flags.
const blocked = () => ({ working: false, waiting: true, event: "Notification" });
const finished = () => ({ working: false, waiting: true, event: "Stop" });

describe("deriveFaviconState", () => {
  it("is idle for no sessions", () => {
    expect(deriveFaviconState([])).toBe("idle");
  });

  it("is idle when every session is quiet", () => {
    expect(deriveFaviconState([a(false, false), a(false, false)])).toBe("idle");
  });

  it("is working when any session is working (and none waiting)", () => {
    expect(deriveFaviconState([a(false, false), a(true, false)])).toBe("working");
  });

  it("is attention when any session is waiting", () => {
    expect(deriveFaviconState([a(false, false), a(false, true)])).toBe("attention");
  });

  it("prioritizes attention over working", () => {
    expect(deriveFaviconState([a(true, false), a(false, true)])).toBe("attention");
    expect(deriveFaviconState([a(true, true)])).toBe("attention");
  });
});

// The tab badge (R14): colour says "something is waiting", the count says how many.
describe("countWaiting", () => {
  it("is zero with nothing to answer", () => {
    expect(countWaiting([])).toBe(0);
    expect(countWaiting([a(true, false), a(false, false)])).toBe(0);
  });

  it("counts every pane blocked on the operator", () => {
    expect(countWaiting([blocked(), a(true, false), blocked()])).toBe(2);
  });

  // A finished turn is reading to catch up on, not a reply anyone is blocked for. Counting it
  // would leave the badge lit permanently, which is the same as no badge at all.
  it("does not count a finished turn", () => {
    expect(countWaiting([finished(), finished()])).toBe(0);
    expect(countWaiting([finished(), blocked()])).toBe(1);
  });
});

describe("titleWithCount", () => {
  it("prefixes the count, and drops it at zero", () => {
    expect(titleWithCount("mulmoterminal", 3)).toBe("(3) mulmoterminal");
    expect(titleWithCount("mulmoterminal", 0)).toBe("mulmoterminal");
  });

  // Repainting reads the title it last wrote, so without stripping it would stack forever.
  it("replaces its own previous count rather than stacking", () => {
    expect(titleWithCount("(3) mulmoterminal", 1)).toBe("(1) mulmoterminal");
    expect(titleWithCount("(3) mulmoterminal", 0)).toBe("mulmoterminal");
  });
});

describe("badgeText", () => {
  it("shows nothing at zero or below", () => {
    expect(badgeText(0)).toBe("");
    expect(badgeText(-1)).toBe("");
    expect(badgeText(Number.NaN)).toBe("");
  });

  // Past ten the exact number stops changing what the operator does, and three digits are
  // illegible once the browser scales the icon to 16px.
  it("caps at 9+", () => {
    expect(badgeText(1)).toBe("1");
    expect(badgeText(9)).toBe("9");
    expect(badgeText(10)).toBe("9+");
    expect(badgeText(30)).toBe("9+");
  });
});
