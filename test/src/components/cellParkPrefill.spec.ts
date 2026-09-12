// What the park box opens holding. The last "resume when" note still wins; a pane that was
// never parked offers the operator's own name for the pane instead of an empty box
// (operator request 2026-09-12) — most panes are named by hand, and retyping the header into
// the box was the only thing standing between "park this" and a card that reads as something.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import TerminalCell from "../../../src/components/TerminalCell.vue";

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

beforeEach(() => {
  globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ working: false, waiting: false }) })) as unknown as typeof fetch;
});
afterEach(() => vi.restoreAllMocks());

const openParkBox = async (props: Record<string, unknown>) => {
  const w = mount(TerminalCell, {
    props: {
      uid: 4,
      expanded: false,
      zoomed: false,
      initialSessionId: SESSION,
      initialCwd: "/w/proj",
      defaultCwd: "/w/proj",
      presets: [],
      home: "/w",
      openSessionIds: [],
      openCwds: [],
      ...props,
    },
  });
  await flushPromises();
  await w.find('[data-testid="cell-park"]').trigger("click");
  await flushPromises();
  return w.find('[data-testid="cell-park-note"]');
};

describe("the park box's opening value", () => {
  it("offers the pane's name when it has never been parked", async () => {
    const box = await openParkBox({ name: "orosy 決済" });
    expect((box.element as HTMLTextAreaElement).value).toBe("orosy 決済");
  });

  it("keeps the last park note ahead of the name", async () => {
    const box = await openParkBox({ name: "orosy 決済", parkNote: "川上さんの返信が来たら" });
    expect((box.element as HTMLTextAreaElement).value).toBe("川上さんの返信が来たら");
  });

  it("opens empty for an unnamed pane that has never been parked", async () => {
    const box = await openParkBox({});
    expect((box.element as HTMLTextAreaElement).value).toBe("");
  });
});
