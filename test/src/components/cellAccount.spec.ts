// The one rule that decides which login a pane starts on.
import { describe, it, expect } from "vitest";
import { cellConnectAccount } from "../../../src/components/cellAccount";

const SESSION = "11111111-2222-3333-4444-555555555555";

describe("cellConnectAccount", () => {
  // The regression that live-testing caught: without this the page's account never reached a
  // spawn, because a launching cell has no stamp yet — the stamp is written from the server's
  // answer, one round trip too late.
  it("hands a launching cell its page's account", () => {
    expect(cellConnectAccount({ session: null }, "b@orosy.co.jp")).toBe("b@orosy.co.jp");
  });

  it("keeps sending what a running pane actually started on", () => {
    expect(cellConnectAccount({ session: SESSION, account: "b@orosy.co.jp" }, "c@orosy.co.jp")).toBe("b@orosy.co.jp");
  });

  // A pane that started before its page named an account stays on the default login: a
  // reconnect must not move a live conversation onto other credentials.
  it("leaves a pane with no stamp on the default login", () => {
    expect(cellConnectAccount({ session: SESSION }, "b@orosy.co.jp")).toBeNull();
  });

  // /ws/codex has no claude.ai login to take; the query would read as an identity it has not got.
  it("never hands a codex cell an account", () => {
    expect(cellConnectAccount({ session: null, agent: "codex" }, "b@orosy.co.jp")).toBeNull();
  });

  it("is null when nothing names an account", () => {
    expect(cellConnectAccount({ session: null }, null)).toBeNull();
    expect(cellConnectAccount({ session: null }, undefined)).toBeNull();
  });
});
