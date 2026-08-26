// The cell's next-instruction queue popover. Pinned: the badge reads unread hand-offs over
// queued items (accent when unread), the popover (teleported to body — it must escape the
// overflow-hidden, draggable cell header) puts the superseded replies FIRST, adding posts to
// the session's queue route, and a pub/sub push for this session replaces the state.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, flushPromises, type VueWrapper } from "@vue/test-utils";

type Callback = (data: unknown) => void;
let captured: Callback | null = null;
vi.mock("../../../src/composables/usePubSub", () => ({
  usePubSub: () => ({
    subscribe: (_channel: string, cb: Callback) => {
      captured = cb;
      return () => {
        captured = null;
      };
    },
    onReconnect: () => () => {},
  }),
}));

import NextQueueMenu from "../../../src/components/NextQueueMenu.vue";

const ID = "11111111-1111-1111-1111-111111111111";
const empty = { auto: true, items: [], handoffs: [] };
const withHandoff = {
  auto: true,
  items: [{ id: "i1", text: "then do B", at: 1 }],
  handoffs: [{ id: "h1", text: "then do A", sentAt: 1_700_000_000_000, prevPrompt: "do the thing", prevReply: "the thing is done", read: false }],
};

function stubFetch(state: unknown) {
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return { ok: true, status: 200, json: async () => ({ id: ID, state }) };
  }) as unknown as typeof fetch;
  return calls;
}

const menu = () => document.body.querySelector('[data-testid="cell-next-queue-menu"]');
const menuEl = (sel: string) => document.body.querySelector<HTMLElement>(`[data-testid="cell-next-queue-menu"] ${sel}`);

let w: VueWrapper | null = null;
beforeEach(() => {
  captured = null;
});
afterEach(() => {
  w?.unmount();
  w = null;
});

describe("NextQueueMenu", () => {
  it("seeds from the queue route and shows no badge when empty", async () => {
    const calls = stubFetch(empty);
    w = mount(NextQueueMenu, { props: { sessionId: ID }, attachTo: document.body });
    await flushPromises();
    expect(calls[0].url).toBe(`/api/session/${ID}/queue`);
    expect(w.find('[data-testid="cell-next-queue-badge"]').exists()).toBe(false);
  });

  it("badges unread hand-offs in accent, ahead of the queued count", async () => {
    stubFetch(withHandoff);
    w = mount(NextQueueMenu, { props: { sessionId: ID }, attachTo: document.body });
    await flushPromises();
    const badge = w.find('[data-testid="cell-next-queue-badge"]');
    expect(badge.text()).toBe("1");
    expect(badge.classes()).toContain("bg-accent");
  });

  it("opens (in body) with the superseded reply first, then the queue", async () => {
    stubFetch(withHandoff);
    w = mount(NextQueueMenu, { props: { sessionId: ID }, attachTo: document.body });
    await flushPromises();
    expect(menu()).toBeNull();
    await w.find('[data-testid="cell-next-queue"]').trigger("click");
    await flushPromises();
    const el = menu();
    expect(el).not.toBeNull();
    expect(w.find('[data-testid="cell-next-queue-menu"]').exists()).toBe(false); // not inside the header
    const text = el?.textContent ?? "";
    expect(text.indexOf("the thing is done")).toBeLessThan(text.indexOf("then do B"));
    expect(menuEl('[data-testid="cell-next-queue-handoff"]')?.textContent).toContain("then do A");
  });

  it("adds a queued instruction through the route and clears the box", async () => {
    const calls = stubFetch(empty);
    w = mount(NextQueueMenu, { props: { sessionId: ID }, attachTo: document.body });
    await flushPromises();
    await w.find('[data-testid="cell-next-queue"]').trigger("click");
    await flushPromises();
    const box = menuEl('[data-testid="cell-next-queue-input"]') as HTMLTextAreaElement;
    box.value = "next: run the tests";
    box.dispatchEvent(new Event("input"));
    await flushPromises();
    menuEl('[data-testid="cell-next-queue-add"]')?.click();
    await flushPromises();
    const post = calls.find((c) => c.init?.method === "POST");
    expect(post?.url).toBe(`/api/session/${ID}/queue`);
    expect(JSON.parse(String(post?.init?.body))).toEqual({ text: "next: run the tests" });
    expect(box.value).toBe("");
  });

  it("stays open when an unrelated element (the terminal viewport) scrolls, and after adding", async () => {
    const calls = stubFetch(empty);
    const viewport = document.createElement("div");
    document.body.appendChild(viewport);
    w = mount(NextQueueMenu, { props: { sessionId: ID }, attachTo: document.body });
    await flushPromises();
    await w.find('[data-testid="cell-next-queue"]').trigger("click");
    await flushPromises();
    expect(menu()).not.toBeNull();
    viewport.dispatchEvent(new Event("scroll", { bubbles: false }));
    await flushPromises();
    expect(menu()).not.toBeNull();
    const box = menuEl('[data-testid="cell-next-queue-input"]') as HTMLTextAreaElement;
    box.value = "then do C";
    box.dispatchEvent(new Event("input"));
    await flushPromises();
    menuEl('[data-testid="cell-next-queue-add"]')?.click();
    await flushPromises();
    expect(calls.some((c) => c.init?.method === "POST")).toBe(true);
    expect(menu()).not.toBeNull();
    expect(menuEl('[data-testid="cell-next-queue-added"]')?.textContent).toContain("then do C");
    viewport.remove();
  });

  it("takes a pub/sub push for its own session and ignores others", async () => {
    stubFetch(empty);
    w = mount(NextQueueMenu, { props: { sessionId: ID }, attachTo: document.body });
    await flushPromises();
    captured?.({ id: "22222222-2222-2222-2222-222222222222", state: withHandoff });
    await flushPromises();
    expect(w.find('[data-testid="cell-next-queue-badge"]').exists()).toBe(false);
    captured?.({ id: ID, state: withHandoff });
    await flushPromises();
    expect(w.find('[data-testid="cell-next-queue-badge"]').text()).toBe("1");
  });
});
