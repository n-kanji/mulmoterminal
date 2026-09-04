import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import TerminalCell from "../../../src/components/TerminalCell.vue";
import { cellName, setCellName, addCellWithCwd, parseGridState, MAX_CELL_NAME, type GridState } from "../../../src/components/gridTabs";

// R10 — a pane the OPERATOR named. Three surfaces: the transform that persists it, the strip
// that shows it (ahead of the AI summary), and the inline rename that sets it.

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
  globalThis.fetch = vi.fn(async (url: string) => {
    const u = String(url);
    if (u.includes("/api/session/")) return { ok: true, json: async () => ({ working: false, waiting: false, aiTitle: "refactoring the router" }) };
    return { ok: true, json: async () => ({}) };
  }) as unknown as typeof fetch;
});
afterEach(() => vi.restoreAllMocks());

const mountCell = async (props: Record<string, unknown> = {}) => {
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
  return w;
};

const mainText = (w: Awaited<ReturnType<typeof mountCell>>) => w.find('[data-testid="cell-strip-summary"]').text();

describe("the pane name transform", () => {
  const base: GridState = { cells: [{ uid: 0, session: null, cwd: "/w" }], expanded: null, page: 0, nextUid: 1, sortMode: "manual" };

  it("trims, and caps at a length that cannot crowd the status row", () => {
    expect(cellName("  api  ")).toBe("api");
    expect(cellName("x".repeat(MAX_CELL_NAME + 20))).toHaveLength(MAX_CELL_NAME);
  });

  // undefined, not "": a persisted empty string would read as "named, with nothing to show"
  // everywhere the field is tested.
  it("clears the name when the field is emptied", () => {
    const named = setCellName(base, 0, "api");
    expect(named.cells[0].name).toBe("api");
    expect(setCellName(named, 0, "   ").cells[0].name).toBeUndefined();
  });

  it("survives a reload, re-trimmed rather than trusted", () => {
    const raw = JSON.stringify({
      cells: [{ uid: 0, session: SESSION, cwd: "/w", name: `  ${"y".repeat(MAX_CELL_NAME + 5)}  ` }],
      expanded: null,
      page: 0,
      sortMode: "manual",
    });
    expect(parseGridState(raw)?.cells[0].name).toHaveLength(MAX_CELL_NAME);
  });

  // The agent self-drive API's `label` has ridden along on the event since R8, logged and
  // dropped because there was no field to put it in. This is that field.
  it("names a column opened by the agent API with its label", () => {
    expect(addCellWithCwd(base, "/w/other", "worker-3").state.cells.at(-1)?.name).toBe("worker-3");
    expect(addCellWithCwd(base, "/w/other").state.cells.at(-1)?.name).toBeUndefined();
    expect(addCellWithCwd(base, "/w/other", "").state.cells.at(-1)?.name).toBeUndefined();
  });
});

describe("the status strip shows the pane's name", () => {
  it("falls back to the AI summary when the pane has no name", async () => {
    const w = await mountCell();
    expect(mainText(w)).toBe("refactoring the router");
    expect(w.find('[data-testid="cell-strip-summary"]').attributes("data-named")).toBeUndefined();
  });

  // Why it OUTRANKS the summary: with four panes open on one repo the summary is the one thing
  // that cannot tell them apart — each says something plausible about the same project.
  it("prefers the name over the AI summary, keeping the summary one hover away", async () => {
    const w = await mountCell({ name: "決済まわり" });
    expect(mainText(w)).toBe("決済まわり");
    expect(w.find('[data-testid="cell-strip-summary"]').attributes("data-named")).toBe("true");
    expect(w.find('[data-testid="cell-strip-summary"]').attributes("title")).toContain("refactoring the router");
  });
});

// 2026-09-04: the name moved INTO the header as a chip a single click opens — the same gesture
// as the separator's label. The operator's mission / last-prompt rows never updated reliably,
// so the name they type themselves is the thing that tells panes apart, and it has to be
// visible and one click away, not hidden behind a double-click on the strip text.
describe("the header's name chip", () => {
  it("shows the name next to the project badge, marked as named", async () => {
    const w = await mountCell({ name: "決済まわり" });
    const chip = w.find('[data-testid="cell-name"]');
    expect(chip.text()).toBe("決済まわり");
    expect(chip.attributes("data-named")).toBe("true");
    expect(chip.element.tagName).toBe("BUTTON"); // a button: shouldZoomOnHeaderClick declines it
  });

  it("invites a name on an unnamed pane instead of showing nothing", async () => {
    const w = await mountCell();
    const chip = w.find('[data-testid="cell-name"]');
    expect(chip.text()).toBe("名前");
    expect(chip.attributes("data-named")).toBeUndefined();
  });

  it("opens the editor on a single click, seeded with the current name, without zooming", async () => {
    const w = await mountCell({ name: "api" });
    await w.find('[data-testid="cell-name"]').trigger("click");
    const input = w.find('[data-testid="cell-name-input"]');
    expect(input.exists()).toBe(true);
    expect((input.element as HTMLInputElement).value).toBe("api");
    expect(input.attributes("maxlength")).toBe(String(MAX_CELL_NAME));
    expect(w.find('[data-testid="cell-name"]').exists()).toBe(false); // the chip IS the input now
    expect(w.emitted("toggle-expand")).toBeUndefined();
  });

  // Selecting text inside the input by dragging must not pick the whole column up.
  it("stops the header being a drag handle while the editor is open", async () => {
    const w = await mountCell({ name: "api" });
    const header = () => w.find(".cell-header");
    expect(header().attributes("draggable")).toBe("true");
    await w.find('[data-testid="cell-name"]').trigger("click");
    expect(header().attributes("draggable")).toBe("false");
    await w.find('[data-testid="cell-name-input"]').trigger("keydown.esc");
    expect(header().attributes("draggable")).toBe("true");
  });

  it("does not zoom the cell when the click lands inside the input", async () => {
    const w = await mountCell({ name: "api" });
    await w.find('[data-testid="cell-name"]').trigger("click");
    await w.find('[data-testid="cell-name-input"]').trigger("click");
    expect(w.emitted("toggle-expand")).toBeUndefined();
  });
});

describe("renaming a pane in place", () => {
  it("still opens on a double-click of the strip text, seeded with the current name", async () => {
    const w = await mountCell({ name: "api" });
    await w.find('[data-testid="cell-strip-summary"]').trigger("dblclick");
    const input = w.find('[data-testid="cell-name-input"]');
    expect(input.exists()).toBe(true);
    expect((input.element as HTMLInputElement).value).toBe("api");
  });

  it("commits on Enter and emits the new name for the grid to persist", async () => {
    const w = await mountCell();
    await w.find('[data-testid="cell-strip-summary"]').trigger("dblclick");
    await w.find('[data-testid="cell-name-input"]').setValue("決済");
    await w.find('[data-testid="cell-name-input"]').trigger("keydown.enter");
    expect(w.emitted("rename")).toEqual([["決済"]]);
    expect(w.find('[data-testid="cell-name-input"]').exists()).toBe(false);
  });

  it("commits on blur — clicking away is a commit, not a loss", async () => {
    const w = await mountCell();
    await w.find('[data-testid="cell-strip-summary"]').trigger("dblclick");
    await w.find('[data-testid="cell-name-input"]').setValue("api");
    await w.find('[data-testid="cell-name-input"]').trigger("blur");
    expect(w.emitted("rename")).toEqual([["api"]]);
  });

  // Enter both commits and takes the input away; the blur that follows must not send a second
  // rename — which, after an Esc, would be the cancelled draft.
  it("commits exactly once for Enter-then-blur, and not at all after Esc", async () => {
    const w = await mountCell({ name: "api" });
    await w.find('[data-testid="cell-strip-summary"]').trigger("dblclick");
    await w.find('[data-testid="cell-name-input"]').setValue("payments");
    await w.find('[data-testid="cell-name-input"]').trigger("keydown.enter");
    expect(w.emitted("rename")).toHaveLength(1);

    await w.find('[data-testid="cell-strip-summary"]').trigger("dblclick");
    await w.find('[data-testid="cell-name-input"]').setValue("scrapped");
    await w.find('[data-testid="cell-name-input"]').trigger("keydown.esc");
    await w.find('[data-testid="cell-strip-summary"]').trigger("dblclick"); // the input is gone
    expect(w.emitted("rename")).toHaveLength(1);
  });

  it("clears the name when the field is emptied", async () => {
    const w = await mountCell({ name: "api" });
    await w.find('[data-testid="cell-strip-summary"]').trigger("dblclick");
    await w.find('[data-testid="cell-name-input"]').setValue("");
    await w.find('[data-testid="cell-name-input"]').trigger("keydown.enter");
    expect(w.emitted("rename")).toEqual([[""]]);
  });

  // The strip has no click action, so the double-click there never fights the header's zoom.
  it("does not zoom the cell — the strip has no click action to fight with", async () => {
    const w = await mountCell();
    await w.find('[data-testid="cell-strip-summary"]').trigger("dblclick");
    expect(w.emitted("toggle-expand")).toBeUndefined();
  });
});
