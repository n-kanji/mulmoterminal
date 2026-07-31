import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import TerminalCell from "../../../src/components/TerminalCell.vue";
import AppToolbar from "../../../src/components/AppToolbar.vue";
import { router } from "../../../src/router/index";
import { connView } from "../../../src/composables/useTerminalConnections";
import { PANE_STATE_WORD } from "../../../common/paneState";
import { countByStatus, gridStatusSummary, type Cell, type CellStatus, type StatusCounts } from "../../../src/components/gridTabs";

// R10's first item was a CHECK, not a build: "is a dead pane visible on the pane itself AND in
// the grid-wide tally?" It is — the six-word vocabulary (Wave 1) and countByStatus / the
// toolbar summary already cover it. These are the regression pins for that answer, at the two
// surfaces that had no test of their own: the cell's own strip and frame, and the toolbar's
// tally. The transforms underneath are covered in gridTabs.spec / paneState.spec.

vi.mock("../../../src/composables/usePubSub", () => ({
  usePubSub: () => ({ subscribe: () => () => {}, onReconnect: () => () => {} }),
}));
vi.mock("../../../src/components/Terminal.vue", () => ({
  default: {
    name: "TerminalView",
    props: ["sessionId", "connectKey", "cwd", "hideHeader"],
    emits: ["session", "cwd"],
    template: '<div class="stub-term" />',
    methods: {
      terminate() {},
    },
  },
}));

const SESSION = "11111111-1111-1111-1111-111111111111";
const UID = 12;

beforeEach(() => {
  connView.clear();
  globalThis.fetch = vi.fn(async (url: string) => {
    const u = String(url);
    // The SERVER's last word on this session is "mid-turn" — the cell must still say it is dead.
    if (u.includes("/api/session/")) return { ok: true, json: async () => ({ working: true, waiting: false }) };
    return { ok: true, json: async () => ({}) };
  }) as unknown as typeof fetch;
});
afterEach(() => {
  connView.clear();
  vi.restoreAllMocks();
});

const mountCell = async () => {
  const w = mount(TerminalCell, {
    props: {
      uid: UID,
      expanded: false,
      zoomed: false,
      initialSessionId: SESSION,
      initialCwd: "/w/proj",
      defaultCwd: "/w/proj",
      presets: [],
      home: "/w",
      openSessionIds: [],
      openCwds: [],
    },
  });
  await flushPromises();
  return w;
};

describe("a dead pane says so on the pane itself", () => {
  it("shows the word 切断 and the red frame once its socket is gone", async () => {
    connView.set(`cell-${UID}`, { status: "disconnected", serverCwd: "/w/proj" });
    const w = await mountCell();
    expect(w.find('[data-testid="cell-strip-state"]').text()).toBe(PANE_STATE_WORD.disconnected);
    expect(w.find(".cell").classes()).toContain("is-disconnected");
    // Red is used by no other state, so a dead pane cannot be misread as a busy one.
    expect(w.find(".cell").classes().join(" ")).toContain("border-[var(--err)]");
  });

  // The server's row describes an agent's turn; it cannot know this browser's socket dropped.
  it("outranks whatever the server last said the session was doing", async () => {
    connView.set(`cell-${UID}`, { status: "disconnected", serverCwd: "/w/proj" });
    const w = await mountCell();
    expect(w.find('[data-testid="cell-strip-state"]').text()).not.toBe(PANE_STATE_WORD.working);
    expect(w.emitted("status")?.at(-1)).toEqual(["disconnected"]);
  });

  it("says 実行中 again on a live socket, so the red state is not the default", async () => {
    connView.set(`cell-${UID}`, { status: "connected", serverCwd: "/w/proj" });
    const w = await mountCell();
    expect(w.find('[data-testid="cell-strip-state"]').text()).toBe(PANE_STATE_WORD.working);
    expect(w.find(".cell").classes()).not.toContain("is-disconnected");
  });
});

describe("a dead pane is counted grid-wide, on every page", () => {
  const cells: Cell[] = [0, 1, 2].map((uid) => ({ uid, session: `s${uid}`, cwd: "/w" }));
  const status: Record<number, CellStatus> = { 0: "disconnected", 1: "working", 2: "disconnected" };

  it("is in the tally and named in the summary", () => {
    const counts = countByStatus(cells, status);
    expect(counts.disconnected).toBe(2);
    const summary = gridStatusSummary(counts);
    expect(summary.show).toBe(true);
    expect(summary.title).toContain("2 disconnected");
  });

  it("shows its own dot in the toolbar, separate from the blocked count", async () => {
    await router.push("/terminals");
    await flushPromises();
    const counts: StatusCounts = { approval: 1, question: 0, disconnected: 2, unread: 0, working: 0, idle: 0, shell: 0 };
    const w = mount(AppToolbar, {
      props: { statusCounts: counts },
      global: { plugins: [router], stubs: { NotificationBell: true, RemoteHostControl: true } },
    });
    await flushPromises();
    const dots = w.findAll('[role="img"] span.inline-flex');
    const texts = dots.map((d) => `${d.classes().join(" ")}|${d.text()}`);
    expect(texts.some((t) => t.includes("text-err") && t.endsWith("|2"))).toBe(true);
    expect(texts.some((t) => t.includes("text-amber") && t.endsWith("|1"))).toBe(true);
  });
});
