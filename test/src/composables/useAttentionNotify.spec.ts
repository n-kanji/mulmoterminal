import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { defineComponent, ref, h } from "vue";
import { mount } from "@vue/test-utils";

const subscribers = new Map<string, (data: unknown) => void>();

vi.mock("../../../src/composables/usePubSub", () => ({
  usePubSub: () => ({
    subscribe: (channel: string, handler: (data: unknown) => void) => {
      subscribers.set(channel, handler);
      return () => subscribers.delete(channel);
    },
    onReconnect: () => () => {},
  }),
}));

const revealed: string[] = [];
vi.mock("../../../src/composables/useRevealSession", () => ({
  revealSession: (id: string) => revealed.push(id),
}));

import {
  createNotifyMemory,
  notifyDecision,
  notifyTitle,
  notifyBody,
  useAttentionNotify,
  type NotifyMemory,
  type NotifyMsg,
} from "../../../src/composables/useAttentionNotify";
import { NOTIFY_COOLDOWN_MS, type NotifyKind } from "../../../common/notifyKinds";

const BLOCKING: NotifyKind[] = ["approval", "question"];

// The wire shapes the server actually publishes, named for what they mean to the operator.
const approval = (id = "s1"): NotifyMsg => ({ id, working: false, waiting: true, event: "Notification", waitKind: "approval" });
const question = (id = "s1"): NotifyMsg => ({ id, working: false, waiting: true, event: "Notification", waitKind: "question" });
const unread = (id = "s1"): NotifyMsg => ({ id, working: false, waiting: true, event: "Stop" });
const working = (id = "s1"): NotifyMsg => ({ id, working: true, waiting: false, event: "UserPromptSubmit" });

// Off screen and out of cooldown — the default conditions, so each test states only its own.
const gate = (over: Partial<Parameters<typeof notifyDecision>[2]> = {}) => ({ kinds: BLOCKING, onScreen: false, now: 1_000_000, ...over });

/** Establish a baseline for `id` so the next message is a real edge, not first sight. */
function seeded(msg: NotifyMsg = working()): NotifyMemory {
  const memory = createNotifyMemory();
  notifyDecision(memory, msg, gate());
  return memory;
}

describe("notifyDecision", () => {
  it("fires on the edge into a blocking state", () => {
    expect(notifyDecision(seeded(), approval(), gate())).toBe("approval");
    expect(notifyDecision(seeded(), question(), gate())).toBe("question");
  });

  // On a reload every live session republishes at once. Without this the operator gets one
  // popup per waiting pane for work they have already seen.
  it("is baseline-only on first sight", () => {
    expect(notifyDecision(createNotifyMemory(), approval(), gate())).toBeNull();
  });

  // A session already blocked that republishes (a new event name on the same wait) has not
  // started needing the operator again — it never stopped.
  it("does not re-fire while the state is unchanged", () => {
    const memory = seeded();
    expect(notifyDecision(memory, approval(), gate())).toBe("approval");
    expect(notifyDecision(memory, approval(), gate())).toBeNull();
  });

  it("says nothing about states that ask for nothing", () => {
    const memory = seeded(approval());
    expect(notifyDecision(memory, working(), gate())).toBeNull();
  });

  describe("the kinds filter", () => {
    it("skips a kind the user did not ask for", () => {
      expect(notifyDecision(seeded(), unread(), gate())).toBeNull();
    });

    it("fires for that same kind once it IS asked for", () => {
      expect(notifyDecision(seeded(), unread(), gate({ kinds: ["approval", "question", "unread"] }))).toBe("unread");
    });

    it("goes silent entirely on an empty list", () => {
      expect(notifyDecision(seeded(), approval(), gate({ kinds: [] }))).toBeNull();
    });
  });

  describe("the cooldown", () => {
    it("suppresses the same session and kind inside five minutes", () => {
      const memory = seeded();
      expect(notifyDecision(memory, approval(), gate({ now: 0 }))).toBe("approval");
      notifyDecision(memory, working(), gate({ now: 1000 })); // leave the state, so the next ask is an edge
      expect(notifyDecision(memory, approval(), gate({ now: NOTIFY_COOLDOWN_MS - 1 }))).toBeNull();
    });

    it("lets it through again once five minutes have passed", () => {
      const memory = seeded();
      notifyDecision(memory, approval(), gate({ now: 0 }));
      notifyDecision(memory, working(), gate({ now: 1000 }));
      expect(notifyDecision(memory, approval(), gate({ now: NOTIFY_COOLDOWN_MS }))).toBe("approval");
    });

    it("is per session, so one pane's cooldown never silences another's", () => {
      const memory = createNotifyMemory();
      notifyDecision(memory, working("a"), gate({ now: 0 }));
      notifyDecision(memory, working("b"), gate({ now: 0 }));
      expect(notifyDecision(memory, approval("a"), gate({ now: 0 }))).toBe("approval");
      expect(notifyDecision(memory, approval("b"), gate({ now: 0 }))).toBe("approval");
    });

    // An escalation from a finished turn to a permission prompt is a DIFFERENT thing to say,
    // so the finished turn's cooldown must not eat it.
    it("is per kind, so an escalation is not eaten by the earlier kind", () => {
      const memory = seeded();
      const all: NotifyKind[] = ["approval", "question", "unread"];
      expect(notifyDecision(memory, unread(), gate({ kinds: all, now: 0 }))).toBe("unread");
      expect(notifyDecision(memory, approval(), gate({ kinds: all, now: 1000 }))).toBe("approval");
    });
  });

  describe("while the page is on screen", () => {
    it("stays silent — the chime and the frame colour already said it", () => {
      expect(notifyDecision(seeded(), approval(), gate({ onScreen: true }))).toBeNull();
    });

    // The regression this ordering exists to prevent: if a suppressed message stamped the
    // cooldown, the operator could look away one second later and hear nothing for five minutes.
    it("does not spend the cooldown on a notification it never raised", () => {
      const memory = seeded();
      expect(notifyDecision(memory, approval(), gate({ onScreen: true, now: 0 }))).toBeNull();
      notifyDecision(memory, working(), gate({ now: 1000 }));
      expect(notifyDecision(memory, approval(), gate({ onScreen: false, now: 2000 }))).toBe("approval");
    });

    // Suppressed is still SEEN: forgetting it would leave the pane looking like it was working,
    // and the next unrelated republish would read as a fresh edge.
    it("still records the state it suppressed", () => {
      const memory = seeded();
      notifyDecision(memory, approval(), gate({ onScreen: true }));
      expect(notifyDecision(memory, approval(), gate({ onScreen: false }))).toBeNull();
    });
  });

  it("forgets a session that closed", () => {
    const memory = seeded(approval());
    notifyDecision(memory, { id: "s1", event: "closed" }, gate());
    expect(memory.states.has("s1")).toBe(false);
  });
});

describe("notification wording", () => {
  it("prefers the session's own summary", () => {
    expect(notifyTitle({ id: "abcdef1234", aiTitle: "Fixing the grid", cwd: "/Users/me/projects/orosy-v2" })).toBe("Fixing the grid");
  });

  it("falls back to the directory name, then to a short id", () => {
    expect(notifyTitle({ id: "abcdef1234", aiTitle: null, cwd: "/Users/me/projects/orosy-v2" })).toBe("orosy-v2");
    expect(notifyTitle({ id: "abcdef1234", aiTitle: "   ", cwd: null })).toBe("abcdef12");
  });

  // The notification and the cell must say the same word, or the operator is comparing two
  // vocabularies across two surfaces.
  it("uses the pane's own status word as the body", () => {
    expect(notifyBody("approval")).toBe("承認待ち");
    expect(notifyBody("question")).toBe("質問");
    expect(notifyBody("unread")).toBe("完了・未読");
  });
});

// --- the composable, against a mocked Notification API -----------------------------------

interface FakeNotification {
  title: string;
  options: NotificationOptions | undefined;
  onclick: (() => void) | null;
  close: () => void;
}
const raised: FakeNotification[] = [];

function installNotification(permission: NotificationPermission, requestPermission = vi.fn(async () => permission)) {
  const ctor = function (this: FakeNotification, title: string, options?: NotificationOptions) {
    this.title = title;
    this.options = options;
    this.onclick = null;
    this.close = vi.fn();
    raised.push(this);
  } as unknown as typeof Notification;
  Object.assign(ctor, { permission, requestPermission });
  vi.stubGlobal("Notification", ctor);
  return { requestPermission };
}

function mountNotifier(kinds: NotifyKind[] = BLOCKING) {
  const component = defineComponent({
    setup() {
      useAttentionNotify(ref(kinds));
      return () => h("div");
    },
  });
  return mount(component);
}

const push = (data: unknown) => subscribers.get("sessions")?.(data);

beforeEach(() => {
  subscribers.clear();
  raised.length = 0;
  revealed.length = 0;
  // Hidden by default, so a test only says so when it wants the suppression path.
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  vi.spyOn(document, "hasFocus").mockReturnValue(false);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useAttentionNotify", () => {
  it("raises a notification for a session that started blocking", () => {
    installNotification("granted");
    mountNotifier();

    push(working());
    push({ ...approval(), aiTitle: "Fixing the grid" });

    expect(raised).toHaveLength(1);
    expect(raised[0].title).toBe("Fixing the grid");
    expect(raised[0].options?.body).toBe("承認待ち");
  });

  // Thirty agents must not become thirty stacked popups: the tag makes a second notification
  // for one session REPLACE its first.
  it("tags each notification with its session", () => {
    installNotification("granted");
    mountNotifier();

    push(working("s7"));
    push(approval("s7"));

    expect(raised[0].options?.tag).toBe("mulmoterminal-s7");
  });

  it("stays silent while the page is visible and focused", () => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    installNotification("granted");
    mountNotifier();

    push(working());
    push(approval());

    expect(raised).toHaveLength(0);
  });

  // A visible-but-unfocused tab is a window the operator is not in — exactly the case a
  // background notification is for.
  it("still notifies a visible tab in an unfocused window", () => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    installNotification("granted");
    mountNotifier();

    push(working());
    push(approval());

    expect(raised).toHaveLength(1);
  });

  it("does nothing at all when permission was denied", () => {
    const { requestPermission } = installNotification("denied");
    mountNotifier();

    push(working());
    push(approval());
    window.dispatchEvent(new MouseEvent("pointerdown"));

    expect(raised).toHaveLength(0);
    expect(requestPermission).not.toHaveBeenCalled();
  });

  // A permission prompt at load is the one people dismiss reflexively, and a dismissal is
  // permanent for the origin.
  it("asks for permission on the first interaction, not at mount", () => {
    const { requestPermission } = installNotification("default");
    mountNotifier();

    expect(requestPermission).not.toHaveBeenCalled();
    window.dispatchEvent(new MouseEvent("pointerdown"));
    expect(requestPermission).toHaveBeenCalledTimes(1);
  });

  it("honours the kinds filter, so a finished turn is silent by default", () => {
    installNotification("granted");
    mountNotifier();

    push(working());
    push(unread());

    expect(raised).toHaveLength(0);
  });

  it("reveals the session when the notification is clicked", () => {
    installNotification("granted");
    const focus = vi.spyOn(window, "focus").mockImplementation(() => {});
    mountNotifier();

    push(working("s3"));
    push(approval("s3"));
    raised[0].onclick?.();

    expect(focus).toHaveBeenCalled();
    expect(revealed).toEqual(["s3"]);
    expect(raised[0].close).toHaveBeenCalled();
  });

  // An insecure origin (plain http on a LAN address, which is how this host is often reached)
  // has no Notification at all. The chime and the tab badge still stand.
  it("survives a browser with no Notification API", () => {
    vi.stubGlobal("Notification", undefined);
    mountNotifier();

    expect(() => {
      push(working());
      push(approval());
    }).not.toThrow();
  });
});
