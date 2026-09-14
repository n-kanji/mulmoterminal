// The one reading of an account address, shared by the grid and the /ws query. It becomes a
// directory name and a Keychain argument, so what it lets through is a security boundary.
import { describe, it, expect } from "vitest";
import { claudeAccountEmail } from "../../common/claudeAccountEmail";

describe("claudeAccountEmail", () => {
  it("normalizes case and surrounding space", () => {
    expect(claudeAccountEmail("  Board@Orosy.CO.jp ")).toBe("board@orosy.co.jp");
  });

  it("takes ordinary addresses", () => {
    expect(claudeAccountEmail("a.b+tag@sub.example.co.uk")).toBe("a.b+tag@sub.example.co.uk");
  });

  // A control character passes `\s`, survives the slug, and is refused only by execFile —
  // inside a spawn that is a socket which never answers.
  it("refuses control characters, NUL included", () => {
    expect(claudeAccountEmail("a\u0000@b.com")).toBeUndefined();
    expect(claudeAccountEmail("a\u001b@b.com")).toBeUndefined();
    expect(claudeAccountEmail("a\u007f@b.com")).toBeUndefined();
  });

  it.each(["", "   ", "nodomain@localhost", "a@b", "a@.b", "a@b.", "../../etc/passwd", "a b@c.co", "a/b@c.co", "a\\b@c.co", 42, null, undefined])(
    "refuses %j",
    (bad) => {
      expect(claudeAccountEmail(bad)).toBeUndefined();
    },
  );

  it("refuses an address longer than an address can be", () => {
    expect(claudeAccountEmail(`${"a".repeat(250)}@b.co`)).toBeUndefined();
  });
});
