// @vitest-environment node
// `?account=` on /ws: what a pane says it runs as, and what a reconnect that says nothing
// falls back to.
import { describe, it, expect, vi, afterEach } from "vitest";
import { accountFromParams, effectiveAccount } from "../../../server/session/launch-account.js";

const params = (qs: string) => new URLSearchParams(qs);

afterEach(() => vi.restoreAllMocks());

describe("accountFromParams", () => {
  it("takes an address, normalized", () => {
    expect(accountFromParams(params("account=%20Board%40Orosy.co.jp%20"))).toBe("board@orosy.co.jp");
  });

  it("is null when the pane names no account", () => {
    expect(accountFromParams(params("cwd=/tmp"))).toBeNull();
  });

  // The value becomes a directory name and a Keychain query. Anything that is not an address
  // falls back to the default login rather than inventing a store nobody can log into.
  it.each(["../../etc/passwd", "a b@c.co", "nodomain@localhost", "a@b", "", "   "])("refuses %j", (bad) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(accountFromParams(params(`account=${encodeURIComponent(bad)}`))).toBeNull();
  });
});

describe("effectiveAccount", () => {
  it("prefers what this connection asked for", () => {
    expect(effectiveAccount("s1", "c@d.co", new Map([["s1", "a@b.co"]]))).toBe("c@d.co");
  });

  // A reconnect with no param must not silently move a running conversation to the default
  // login — the session keeps the account it was started on.
  it("falls back to what the session was started as", () => {
    expect(effectiveAccount("s1", null, new Map([["s1", "a@b.co"]]))).toBe("a@b.co");
  });

  it("is null when neither knows", () => {
    expect(effectiveAccount("s1", null, new Map())).toBeNull();
  });
});
