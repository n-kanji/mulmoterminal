import { describe, it, expect, vi, afterEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import TranscriptOverlay from "../../../src/components/TranscriptOverlay.vue";
import { renderTurnHtml } from "../../../src/transcriptMarkdown";

const turns = [
  { role: "user", text: "first question" },
  { role: "assistant", text: "**bold answer** with `code`" },
  { role: "user", text: "follow-up" },
  { role: "assistant", text: "second answer" },
];

const mockFetch = (payload: unknown, ok = true) => vi.fn().mockResolvedValue({ ok, json: () => Promise.resolve(payload) });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("TranscriptOverlay", () => {
  it("renders nothing when closed", () => {
    const w = mount(TranscriptOverlay, { props: { sessionId: "s", cwd: "/x", open: false } });
    expect(w.find('[data-testid="tr-modal"]').exists()).toBe(false);
  });

  it("renders prompts as plain quotes and replies as markdown, in order", async () => {
    vi.stubGlobal("fetch", mockFetch({ turns, truncated: false }));
    const w = mount(TranscriptOverlay, { props: { sessionId: "s", cwd: "/x", open: true } });
    await flushPromises();
    const prompts = w.findAll('[data-testid="tr-prompt"]');
    const replies = w.findAll('[data-testid="tr-reply"]');
    expect(prompts.map((n) => n.text())).toEqual(["first question", "follow-up"]);
    expect(replies).toHaveLength(2);
    // The reply is RENDERED (strong/code elements), not shown as raw markdown.
    expect(replies[0].find("strong").text()).toBe("bold answer");
    expect(replies[0].find("code").text()).toBe("code");
    expect(w.find('[data-testid="tr-count"]').text()).toContain("4");
  });

  it("marks a truncated conversation as showing only the recent turns", async () => {
    vi.stubGlobal("fetch", mockFetch({ turns, truncated: true }));
    const w = mount(TranscriptOverlay, { props: { sessionId: "s", cwd: "/x", open: true } });
    await flushPromises();
    expect(w.find('[data-testid="tr-count"]').text()).toContain("直近");
    expect(w.text()).toContain("それより前のターンは省略");
  });

  it("shows an empty state for a session with no conversation yet", async () => {
    vi.stubGlobal("fetch", mockFetch({ turns: [], truncated: false }));
    const w = mount(TranscriptOverlay, { props: { sessionId: "s", cwd: "/x", open: true } });
    await flushPromises();
    expect(w.find('[data-testid="tr-empty"]').text()).toContain("まだ会話がありません");
  });

  it("shows an error state when the fetch fails", async () => {
    vi.stubGlobal("fetch", mockFetch({}, false));
    const w = mount(TranscriptOverlay, { props: { sessionId: "s", cwd: "/x", open: true } });
    await flushPromises();
    expect(w.find('[data-testid="tr-empty"]').text()).toContain("読み込めませんでした");
  });

  it("emits close from the close button and on a document-level Escape", async () => {
    vi.stubGlobal("fetch", mockFetch({ turns, truncated: false }));
    const w = mount(TranscriptOverlay, { attachTo: document.body, props: { sessionId: "s", cwd: "/x", open: true } });
    await flushPromises();
    await w.find('[data-testid="tr-close"]').trigger("click");
    expect(w.emitted("close")).toHaveLength(1);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(w.emitted("close")).toHaveLength(2);
    w.unmount();
  });

  it("refetches on the refresh button (fresh turns while the agent keeps working)", async () => {
    const fetchMock = mockFetch({ turns, truncated: false });
    vi.stubGlobal("fetch", fetchMock);
    const w = mount(TranscriptOverlay, { props: { sessionId: "s", cwd: "/x", open: true } });
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await w.find('[data-testid="tr-refresh"]').trigger("click");
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reloads when the session changes while the overlay stays open", async () => {
    const fetchMock = mockFetch({ turns, truncated: false });
    vi.stubGlobal("fetch", fetchMock);
    const w = mount(TranscriptOverlay, { props: { sessionId: "a", cwd: "/x", open: true } });
    await flushPromises();
    await w.setProps({ sessionId: "b" });
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    w.unmount();
  });
});

describe("renderTurnHtml", () => {
  it("renders markdown and strips script content (LLM-authored text via v-html)", () => {
    const html = renderTurnHtml("# h\n\n<script>alert(1)<" + '/script><p onclick="x()">hi</p>');
    expect(html).toContain("<h1>");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("onclick");
  });
});
