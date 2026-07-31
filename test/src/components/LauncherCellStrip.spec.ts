import { describe, it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";
import LauncherCell from "../../../src/components/LauncherCell.vue";
import { PANE_STATE_WORD } from "../../../common/paneState";
import { STRIP_STATUS } from "../../../src/components/cellStatusStyles";

// R10 — a shell pane wears the SAME two rows a Claude pane does: row 1 identity + actions,
// row 2 the status strip. It used to carry a single row whose dot had two colours and no word,
// so scanning thirty columns meant reading two different pane languages.

vi.mock("../../../src/components/Terminal.vue", () => ({
  default: {
    name: "TerminalView",
    props: ["persistKey", "sessionId", "connectKey", "cwd", "launcher"],
    emits: ["session", "exit"],
    template: '<div class="stub-term" />',
  },
}));

const baseProps = { uid: 7, expanded: false, launcher: { index: 1, label: "zsh" }, session: null, cwd: "/work/proj", home: "/work" };
const mountCell = (extra: Record<string, unknown> = {}) => mount(LauncherCell, { props: { ...baseProps, ...extra } });
const exit = async (w: ReturnType<typeof mountCell>) => {
  w.findComponent({ name: "TerminalView" }).vm.$emit("exit");
  await w.vm.$nextTick();
};

describe("the launcher pane's two-row header", () => {
  it("has the identity row and the status strip, in that order", () => {
    const w = mountCell();
    expect(w.find(".cell-header").exists()).toBe(true);
    expect(w.find('[data-testid="cell-status-strip"]').exists()).toBe(true);
    const html = w.html();
    expect(html.indexOf("cell-header")).toBeLessThan(html.indexOf("cell-status-strip"));
  });

  // The vocabulary is the point: "シェル" is the same word, in the same slot, with the same
  // colour table as "実行中" one column over.
  it("says シェル while the program runs, and 切断 once it has exited", async () => {
    const w = mountCell();
    expect(w.find('[data-testid="cell-strip-state"]').text()).toBe(PANE_STATE_WORD.shell);
    expect(w.find('[data-testid="cell-strip-state"]').classes().join(" ")).toContain(STRIP_STATUS.shell);
    await exit(w);
    expect(w.find('[data-testid="cell-strip-state"]').text()).toBe(PANE_STATE_WORD.disconnected);
    expect(w.find('[data-testid="cell-strip-state"]').classes().join(" ")).toContain(STRIP_STATUS.disconnected);
  });

  it("reports the same two states up to the grid, for the tally and the auto sort", async () => {
    const w = mountCell();
    expect(w.emitted("status")).toEqual([["shell"]]);
    await exit(w);
    expect(w.emitted("status")).toEqual([["shell"], ["disconnected"]]);
  });

  // What it RUNS is the whole answer to "what is this pane", so the label takes the row's one
  // flexible slot — where a Claude pane puts its name or summary.
  it("puts what it runs in the strip's flexible slot, with the directory beside it", () => {
    const w = mountCell();
    const strip = w.find('[data-testid="cell-status-strip"]');
    expect(strip.find(".cell-cmd").text()).toContain("zsh");
    expect(strip.find(".cell-dir").text()).toBe("~/proj");
  });

  it("keeps the header's click-to-zoom and its buttons on row 1", async () => {
    const w = mountCell();
    expect(w.find(".cell-header").classes()).toContain("is-zoomable");
    await w.find(".cell-header").trigger("click");
    expect(w.emitted("toggle-expand")).toHaveLength(1);
    await w.find('[aria-label="Close terminal"]').trigger("click");
    expect(w.emitted("close")).toHaveLength(1);
  });

  // The relaunch button is the answer to the word next to it — pressing it must not also zoom
  // the cell, which a header-background click does.
  it("offers relaunch only once the program exited, without zooming on the way", async () => {
    const w = mountCell();
    expect(w.find('[aria-label="Relaunch"]').exists()).toBe(false);
    await exit(w);
    await w.find('[aria-label="Relaunch"]').trigger("click");
    expect(w.emitted("toggle-expand")).toBeUndefined();
    expect(w.find('[data-testid="cell-strip-state"]').text()).toBe(PANE_STATE_WORD.shell);
  });
});
