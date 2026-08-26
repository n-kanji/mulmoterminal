// One cell's next-instruction queue (plans/feat-next-instruction-queue.md): the state as the
// host holds it, kept current over pub/sub, plus the writes. Same seed-then-subscribe shape as
// useGridActivity — pushes carry whole states, so the only race is a push arriving before the
// seed answers, and a whole-state push is never staler than the seed it beats.
import { onUnmounted, ref, watch, type Ref } from "vue";
import { EMPTY_NEXT_QUEUE, NEXT_QUEUE_CHANNEL, nextQueueEventOf, nextQueueStateOf, type NextQueueState } from "../../common/nextQueue";
import { usePubSub } from "./usePubSub";

async function postJson(url: string, method: string, body?: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const error =
      json && typeof json === "object" && typeof (json as { error?: unknown }).error === "string" ? (json as { error: string }).error : `HTTP ${res.status}`;
    throw new Error(error);
  }
  return json;
}

const stateOfReply = (json: unknown): NextQueueState | null =>
  json && typeof json === "object" ? nextQueueStateOf((json as { state?: unknown }).state) : null;

export function useNextQueue(sessionId: Ref<string | null>) {
  const state = ref<NextQueueState>({ ...EMPTY_NEXT_QUEUE, items: [], handoffs: [] });
  const error = ref<string | null>(null);
  const { subscribe, onReconnect } = usePubSub();

  const base = () => `/api/session/${sessionId.value}/queue`;

  async function seed(): Promise<void> {
    const id = sessionId.value;
    if (!id) {
      state.value = { ...EMPTY_NEXT_QUEUE, items: [], handoffs: [] };
      return;
    }
    try {
      const next = stateOfReply(await postJson(`/api/session/${id}/queue`, "GET"));
      if (next && sessionId.value === id) state.value = next;
    } catch {
      // the host is away; the push will bring the state when it is back
    }
  }

  const unsub = subscribe(NEXT_QUEUE_CHANNEL, (data) => {
    const ev = nextQueueEventOf(data);
    if (ev && ev.id === sessionId.value) state.value = ev.state;
  });
  const offReconnect = onReconnect(() => void seed());
  watch(sessionId, () => void seed(), { immediate: true });
  onUnmounted(() => {
    unsub();
    offReconnect();
  });

  async function apply(fn: () => Promise<unknown>): Promise<boolean> {
    error.value = null;
    try {
      const next = stateOfReply(await fn());
      if (next) state.value = next;
      return true;
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  const add = (text: string) => apply(() => postJson(base(), "POST", { text }));
  const remove = (itemId: string) => apply(() => postJson(`${base()}/${itemId}`, "DELETE"));
  const setAuto = (enabled: boolean) => apply(() => postJson(`${base()}/auto`, "PUT", { enabled }));
  const sendNow = () => apply(() => postJson(`${base()}/send-next`, "POST"));
  const markRead = () => apply(() => postJson(`${base()}/read`, "POST"));

  return { state, error, add, remove, setAuto, sendNow, markRead, refresh: seed };
}
