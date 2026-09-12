// The parked dock's cards: the order they stand in, and the two ways the operator changes it
// (operator request 2026-09-13). Drag carries its own MIME so a file — or a column dragged off
// the grid — passes over the dock without shuffling anything.
import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import ParkedDock, { type ParkedCard } from "../../../src/components/ParkedDock.vue";
import { PARK_DRAG_MIME, CELL_DRAG_MIME } from "../../../src/components/gridTabs";

const card = (uid: number, name: string, at: number): ParkedCard => ({
  uid,
  cwd: "/w/proj",
  name,
  note: "返信待ち",
  at,
  status: "idle",
  headerColor: null,
});

// A DataTransfer stand-in: jsdom has no drag payloads.
const transfer = (mime: string | null, uid?: number) => ({
  types: mime ? [mime] : [],
  getData: (t: string) => (mime && t === mime && uid !== undefined ? String(uid) : ""),
  setData: () => {},
  effectAllowed: "",
  dropEffect: "",
});

const mountDock = (items: ParkedCard[]) => mount(ParkedDock, { props: { items, home: "/w" } });
const names = (w: ReturnType<typeof mountDock>) => w.findAll('[data-testid="parked-card"]').map((c) => c.findComponent({ name: "DirBadge" }).text());

// Deliberately out of time order: the state's order wins, not `at`.
const items = [card(1, "決済", 100), card(2, "検索", 300), card(3, "請求", 200)];

describe("ParkedDock", () => {
  it("stands the cards in the order it is given, not by when they were parked", () => {
    expect(names(mountDock(items))).toEqual(["決済", "検索", "請求"]);
  });

  it("asks to move the dragged card onto the one it was dropped on", async () => {
    const w = mountDock(items);
    const cards = w.findAll('[data-testid="parked-card"]');
    await cards[2].trigger("dragstart", { dataTransfer: transfer(PARK_DRAG_MIME, 3) });
    await cards[0].trigger("drop", { dataTransfer: transfer(PARK_DRAG_MIME, 3) });
    expect(w.emitted("reorder")).toEqual([[3, 1]]);
  });

  it("ignores a drop that is not a parked card — a file, or a column off the grid", async () => {
    const w = mountDock(items);
    const first = w.findAll('[data-testid="parked-card"]')[0];
    await first.trigger("drop", { dataTransfer: transfer(CELL_DRAG_MIME, 2) });
    await first.trigger("drop", { dataTransfer: transfer(null) });
    expect(w.emitted("reorder")).toBeUndefined();
  });

  it("does not ask for a move when a card is dropped on itself", async () => {
    const w = mountDock(items);
    const first = w.findAll('[data-testid="parked-card"]')[0];
    await first.trigger("drop", { dataTransfer: transfer(PARK_DRAG_MIME, 1) });
    expect(w.emitted("reorder")).toBeUndefined();
  });

  it("moves a card with Alt+Up / Alt+Down, and stops at the ends", async () => {
    const w = mountDock(items);
    const cards = w.findAll('[data-testid="parked-card"]');
    await cards[1].trigger("keydown", { key: "ArrowUp", altKey: true });
    expect(w.emitted("reorder")).toEqual([[2, 1]]);
    await cards[0].trigger("keydown", { key: "ArrowUp", altKey: true });
    await cards[2].trigger("keydown", { key: "ArrowDown", altKey: true });
    expect(w.emitted("reorder")).toHaveLength(1);
  });

  it("leaves a plain arrow key alone — only Alt reorders", async () => {
    const w = mountDock(items);
    await w.findAll('[data-testid="parked-card"]')[1].trigger("keydown", { key: "ArrowUp" });
    expect(w.emitted("reorder")).toBeUndefined();
  });

  it("still restores on click and Enter", async () => {
    const w = mountDock(items);
    const first = w.findAll('[data-testid="parked-card"]')[0];
    await first.trigger("click");
    await first.trigger("keydown.enter");
    expect(w.emitted("restore")).toEqual([[1], [1]]);
  });
});
