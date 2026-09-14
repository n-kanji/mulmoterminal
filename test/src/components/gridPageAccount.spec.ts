// Per-page Claude accounts in the grid state (operator request 2026-09-14): a page names an
// account, a pane freezes the one it launched on, and both survive a reload.
import { describe, it, expect } from "vitest";
import {
  pageAccount,
  pageAccountOfCell,
  parseGridState,
  setPageAccount,
  setSession,
  stampAccount,
  PAGE_SIZE,
  type GridState,
} from "../../../src/components/gridTabs";

const cell = (uid: number, session: string | null = null) => ({ uid, session, cwd: "/tmp" });
const base = (cells = [cell(0)]): GridState => ({ cells, expanded: null, page: 0, nextUid: cells.length, sortMode: "manual" });
const UUID = "11111111-2222-3333-4444-555555555555";

describe("a page's account", () => {
  it("is absent until one is picked, and clears back to the default login", () => {
    const state = base();
    expect(pageAccount(state, 0)).toBeNull();
    const assigned = setPageAccount(state, 0, "B@Orosy.co.jp");
    expect(pageAccount(assigned, 0)).toBe("b@orosy.co.jp");
    expect(pageAccount(setPageAccount(assigned, 0, null), 0)).toBeNull();
  });

  it("belongs to that page only", () => {
    const state = setPageAccount(base(), 1, "b@orosy.co.jp");
    expect(pageAccount(state, 0)).toBeNull();
    expect(pageAccount(state, 1)).toBe("b@orosy.co.jp");
  });

  it("refuses anything that is not an address", () => {
    expect(pageAccount(setPageAccount(base(), 0, "../../etc/passwd"), 0)).toBeNull();
  });

  // A cell is stamped from ITS page, which is not necessarily the one on screen.
  it("is read for a cell from the page the cell sits on", () => {
    const cells = Array.from({ length: PAGE_SIZE + 1 }, (_, i) => cell(i, UUID));
    const state = setPageAccount({ ...base(cells), page: 0 }, 1, "b@orosy.co.jp");
    expect(pageAccountOfCell(state, 0)).toBeNull();
    expect(pageAccountOfCell(state, PAGE_SIZE)).toBe("b@orosy.co.jp");
    expect(pageAccountOfCell(state, 999)).toBeNull();
  });
});

describe("the account a pane launched on", () => {
  it("is stamped when the pane reports its session", () => {
    const state = stampAccount(setSession(base(), 0, UUID), 0, "b@orosy.co.jp");
    expect(state.cells[0].account).toBe("b@orosy.co.jp");
  });

  // The process holds its credentials for life, so a later page change must not rewrite what
  // a running pane is actually on — that is the whole reason the pane labels itself.
  it("is never rewritten by a second stamp", () => {
    const first = stampAccount(base(), 0, "b@orosy.co.jp");
    expect(stampAccount(first, 0, "c@orosy.co.jp").cells[0].account).toBe("b@orosy.co.jp");
  });

  it("is left off when the page follows the default login", () => {
    expect(stampAccount(base(), 0, null).cells[0].account).toBeUndefined();
  });
});

describe("persistence", () => {
  it("round-trips both the page's account and the pane's", () => {
    const state = stampAccount(setPageAccount(base([cell(0, UUID)]), 0, "b@orosy.co.jp"), 0, "b@orosy.co.jp");
    const back = parseGridState(JSON.stringify(state));
    expect(back?.cells[0].account).toBe("b@orosy.co.jp");
    expect(pageAccount(back as GridState, 0)).toBe("b@orosy.co.jp");
  });

  // The blob is hand-editable and its values reach a Keychain query on the server.
  it("drops a hand-written account that is not an address", () => {
    const raw = JSON.stringify({
      cells: [{ uid: 0, session: UUID, cwd: "/tmp", account: "/etc/shadow" }],
      expanded: null,
      page: 0,
      nextUid: 1,
      sortMode: "manual",
      pages: [{ account: "not-an-email" }],
    });
    const back = parseGridState(raw);
    expect(back?.cells[0].account).toBeUndefined();
    expect(pageAccount(back as GridState, 0)).toBeNull();
  });
});
