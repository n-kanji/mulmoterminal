import { describe, it, expect } from "vitest";
import { DEFAULT_COPY_ON_SELECT, sanitizeCopyOnSelect } from "../../common/copyOnSelect";

describe("copyOnSelect", () => {
  it("defaults ON", () => {
    expect(DEFAULT_COPY_ON_SELECT).toBe(true);
  });

  // The default is what every config.json written before this feature says (nothing), so
  // "absent" has to mean enabled or the feature ships off for every existing user.
  it("treats a missing / unknown value as enabled", () => {
    expect(sanitizeCopyOnSelect(undefined)).toBe(true);
    expect(sanitizeCopyOnSelect(null)).toBe(true);
    expect(sanitizeCopyOnSelect("no")).toBe(true);
    expect(sanitizeCopyOnSelect(0)).toBe(true);
  });

  it("only an explicit false turns it off", () => {
    expect(sanitizeCopyOnSelect(false)).toBe(false);
    expect(sanitizeCopyOnSelect(true)).toBe(true);
  });
});
