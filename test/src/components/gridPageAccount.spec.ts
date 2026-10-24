// Per-page Claude accounts in the grid state (operator request 2026-09-14): a page names an
// account, a pane freezes the one it launched on, and both survive a reload.
import { describe, it, expect } from "vitest";
import {
  addPage,
  isPagePinned,
  pageAccount,
  pageCount,
  pageSlice,
  parseGridState,
  realCells,
  restampPanes,
  pageClaudeSessions,
  setPageAccount,
  setSession,
  stampAccount,
  MAX_PAGES,
  PAGE_SIZE,
  type GridState,
} from "../../../src/components/gridTabs";
import { cellConnectAccount } from "../../../src/components/cellAccount";

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

  it("is never written onto a codex pane", () => {
    const cells = [{ uid: 0, session: UUID, cwd: "/tmp", agent: "codex" as const }];
    expect(stampAccount(base(cells), 0, "b@orosy.co.jp").cells[0].account).toBeUndefined();
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

// A page you open on purpose (operator request 2026-09-14). Before per-page accounts there was
// nothing to want one FOR, and the only way to make one was to send a column to "N枚目（新規）".
describe("opening a page", () => {
  const busy = (n: number) => Array.from({ length: n }, (_, i) => ({ uid: i, session: `${i}`.repeat(8), cwd: "/tmp" }));

  it("adds a page, moves to it, and puts a launch form there to start from", () => {
    const next = addPage(base(busy(2)));
    expect(pageCount(next.cells.length)).toBe(2);
    expect(next.page).toBe(1);
    expect(realCells(pageSlice(next.cells, 1))).toHaveLength(1);
    expect(realCells(pageSlice(next.cells, 1))[0].session).toBeNull();
  });

  // Unpinned, an elastic list packs the columns forward and the new page evaporates the moment
  // it is left — which is exactly when the operator goes off to give it an account.
  it("seals the boundary so the page survives being left", () => {
    const next = addPage(base(busy(2)));
    expect(isPagePinned(next, 1)).toBe(true);
    // The page before it keeps its full width in reserved slots, which is what stops the two
    // columns from packing forward and swallowing the new page again.
    expect(pageSlice(next.cells, 0)).toHaveLength(PAGE_SIZE);
    expect(realCells(pageSlice(next.cells, 0))).toHaveLength(2);
  });

  it("keeps the columns that were already there", () => {
    const next = addPage(base(busy(3)));
    expect(realCells(next.cells).filter((c) => c.session !== null)).toHaveLength(3);
  });

  it("stops at the last page rather than losing the request quietly", () => {
    let state = base(busy(2));
    for (let i = 1; i < MAX_PAGES; i++) state = addPage(state);
    expect(pageCount(state.cells.length)).toBe(MAX_PAGES);
    expect(addPage(state)).toBe(state);
  });

  // The point of the button: the new page is where another subscription lives.
  it("is somewhere an account can be named", () => {
    const next = setPageAccount(addPage(base(busy(2))), 1, "b@orosy.co.jp");
    expect(pageAccount(next, 1)).toBe("b@orosy.co.jp");
    expect(pageAccount(next, 0)).toBeNull();
    expect(pageAccount(parseGridState(JSON.stringify(next)) as GridState, 1)).toBe("b@orosy.co.jp");
  });

  it("leaves the grid alone when the terminals are all used up", () => {
    const full = base(busy(PAGE_SIZE * MAX_PAGES));
    expect(addPage(full)).toBe(full);
  });
});

// The one deliberate exception to "a stamp is for life" (operator request 2026-09-28): the
// chip's "move this page's running panes" re-stamps them and names the sessions to restart.
describe("restampPanes", () => {
  type Cell = GridState["cells"][number];
  const stamped = (uid: number, session: string | null, account?: string, extra: Partial<Cell> = {}): Cell => ({
    ...cell(uid, session),
    ...(account ? { account } : {}),
    ...extra,
  });
  const grid = (cells: Cell[]): GridState => ({ ...base(), cells, nextUid: cells.length });

  it("re-stamps the running claude panes among the uids and returns exactly their sessions", () => {
    const state = grid([
      stamped(0, "s0"), // launched on the default login before the page was assigned
      stamped(1, "s1", "kanji@spaceengine.io"), // stamped with the other account
      stamped(2, "s2", "b@orosy.co.jp"), // already there: untouched, not restarted
      stamped(3, null), // no session: nothing to restart, will inherit on launch
      stamped(4, "s4", undefined, { agent: "codex" as const }), // not a claude.ai login at all
      stamped(5, "s5"), // not among the uids (another page)
    ]);
    const moved = restampPanes(state, [0, 1, 2, 3, 4], "B@Orosy.co.jp");
    expect(moved.sessions).toEqual(["s0", "s1"]);
    const by = (uid: number): Cell => moved.state.cells.find((c) => c.uid === uid) ?? stamped(-1, null);
    expect(by(0)?.account).toBe("b@orosy.co.jp");
    expect(by(1)?.account).toBe("b@orosy.co.jp");
    expect(by(2)?.account).toBe("b@orosy.co.jp");
    expect(by(3)?.account).toBeUndefined();
    expect(by(4)?.account).toBeUndefined();
    expect(by(5)?.account).toBeUndefined();
    // A cell that now carries the page's account CONNECTS as it — that is what the restart reads.
    expect(cellConnectAccount(by(0), "b@orosy.co.jp")).toBe("b@orosy.co.jp");
  });

  it("moves panes back onto the default login by clearing their stamps, and is a no-op when everyone is there already", () => {
    const state = grid([stamped(0, "s0", "b@orosy.co.jp"), stamped(1, "s1")]);
    const moved = restampPanes(state, [0, 1], null);
    expect(moved.sessions).toEqual(["s0"]);
    // Cleared means ABSENT, not `account: undefined` — the persisted blob must not carry the key.
    expect(Object.keys(moved.state.cells[0])).not.toContain("account");
    // Second click: nothing differs, so the state object itself is returned and no session named.
    const again = restampPanes(moved.state, [0, 1], null);
    expect(again.state).toBe(moved.state);
    expect(again.sessions).toEqual([]);
  });

  it("pageClaudeSessions lists every running claude pane among the uids — what a reload restarts when nothing needs moving (2026-10-24)", () => {
    const state = grid([
      stamped(0, "s0", "b@orosy.co.jp"),
      stamped(1, "s1", "b@orosy.co.jp"),
      stamped(2, null), // no session: nothing to restart
      stamped(3, "s3", undefined, { agent: "codex" as const }), // not a claude.ai login
      stamped(4, "s4", "b@orosy.co.jp"), // another page
    ]);
    // All stamped already, so the move names nothing — the page-wide list is still these two.
    expect(restampPanes(state, [0, 1, 2, 3], "b@orosy.co.jp").sessions).toEqual([]);
    expect(pageClaudeSessions(state, [0, 1, 2, 3])).toEqual(["s0", "s1"]);
  });

  it("survives a reload: the new stamp is what comes back from localStorage", () => {
    const moved = restampPanes(grid([stamped(0, UUID)]), [0], "b@orosy.co.jp");
    const back = parseGridState(JSON.stringify(moved.state)) as GridState;
    expect(back.cells[0].account).toBe("b@orosy.co.jp");
  });
});
