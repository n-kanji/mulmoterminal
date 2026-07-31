// Drives the favicon off LIVE activity across EVERY session — the global "sessions"
// pub-sub stream the attention beep uses — so it never diverges from the beep and
// covers other-directory grid sessions too. The stream only carries transitions, so
// it's reconciled against the authoritative session list (useSessions: seeded on
// mount, refetched on each push, resynced on reconnect): that list's truth is adopted
// and any default-project session it stops reporting is pruned — the safety net that
// lets a missed "closed" (e.g. one that happened while the socket was down) recover.
import { computed, onUnmounted, ref, watch, type Ref } from "vue";
import { usePubSub } from "./usePubSub";
import { useDynamicFavicon } from "./useDynamicFavicon";
import type { Session } from "./useSessions";
import { isRecord } from "../../common/isRecord";
import { paneStateOf } from "../../common/paneState";
import { isActionState } from "../../common/notifyKinds";

export type FaviconState = "idle" | "working" | "attention";

interface Activity {
  working: boolean;
  waiting: boolean;
  /** Which hook set the state. Needed beyond the colour: it is what separates a pane BLOCKED on
   *  the operator (Notification) from one that merely finished (Stop), i.e. what the count
   *  counts. Absent for the authoritative list's older rows, which then read as finished. */
  event?: string | null;
}
interface ActivityMsg {
  id: string;
  working?: boolean;
  waiting?: boolean;
  event?: string | null;
}
const isActivityMsg = (d: unknown): d is ActivityMsg => isRecord(d) && "id" in d;

// attention(waiting) wins over working wins over idle — matching the grid cell's own
// status priority, so the tab icon agrees with the cell border.
export function deriveFaviconState(activities: Iterable<Activity>): FaviconState {
  let working = false;
  for (const a of activities) {
    if (a.waiting) return "attention";
    if (a.working) working = true;
  }
  return working ? "working" : "idle";
}

/** How many panes are waiting on an ANSWER (承認待ち / 質問) — the tab badge's tally and the
 *  "(N)" in the title. Derived through paneStateOf rather than by reading the flags directly,
 *  so the number can never disagree with the words the cells are showing. A finished turn is
 *  excluded on purpose: it is reading to catch up on, not a reply anyone is blocked for, and
 *  including it would leave the badge permanently lit. */
export function countWaiting(activities: Iterable<Activity>): number {
  let waiting = 0;
  for (const a of activities) {
    const state = paneStateOf({ working: a.working, waiting: a.waiting, event: a.event, waitKind: null, connected: true });
    if (isActionState(state)) waiting++;
  }
  return waiting;
}

/** The tab title for a waiting count. The base title is whatever the document already had, with
 *  any previous count stripped — so repainting never stacks "(2) (1) mulmoterminal". */
export function titleWithCount(title: string, count: number): string {
  const base = title.replace(/^\(\d+\)\s*/, "");
  return count > 0 ? `(${count}) ${base}` : base;
}

const STATE_COLOR: Record<FaviconState, string> = {
  idle: "#8a8aa0", // slate — nothing happening
  working: "#4a8cff", // blue — Claude is thinking
  attention: "#e0a030", // amber — needs you
};

export function useFaviconState(sessions: Ref<Session[]>): void {
  const live = ref(new Map<string, Activity>());

  const { subscribe } = usePubSub();
  const unsubscribe = subscribe("sessions", (d) => {
    if (!isActivityMsg(d)) return;
    const next = new Map(live.value);
    if (d.event === "closed") next.delete(d.id);
    else next.set(d.id, { working: d.working ?? false, waiting: d.waiting ?? false, event: d.event ?? null });
    live.value = next;
  });
  onUnmounted(unsubscribe);

  // Reconcile with the authoritative list: adopt its truth and drop default-project
  // ids it no longer reports (cross-dir grid ids never appear here, so they stay,
  // pruned instead by their own "closed" event above).
  let prevAuthIds = new Set<string>();
  watch(
    sessions,
    (list) => {
      const next = new Map(live.value);
      const authIds = new Set<string>();
      for (const s of list) {
        authIds.add(s.id);
        next.set(s.id, { working: s.working, waiting: s.waiting, event: s.event ?? null });
      }
      for (const id of prevAuthIds) if (!authIds.has(id)) next.delete(id);
      prevAuthIds = authIds;
      live.value = next;
    },
    { immediate: true },
  );

  const color = computed(() => STATE_COLOR[deriveFaviconState(live.value.values())]);
  const waiting = computed(() => countWaiting(live.value.values()));
  useDynamicFavicon(color, waiting);
  // The same number in the tab TITLE as on the icon. Both are needed: a pinned or narrow tab
  // shows only the favicon, while a browser that downscales it past legibility still shows the
  // text — and the title is what a window switcher (Cmd+Tab, Mission Control) reads.
  watch(waiting, (n) => (document.title = titleWithCount(document.title, n)), { immediate: true });
}
