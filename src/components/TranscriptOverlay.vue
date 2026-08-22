<script setup lang="ts">
// Fork-local (iTerm2 mode): the READING VIEW — one session's conversation with every
// tool record dropped, prompts as compact quotes and replies rendered as Markdown.
// Solves the operator's scroll-back pain: a long turn buries its earlier replies under
// tool logs, and the terminal keeps only the final summary on screen. Opened from the
// cell header's book button; modeled on TimelineOverlay (same modal, keyboard and
// load-supersede behavior).
import { ref, watch, onUnmounted, nextTick } from "vue";
import { trapTabKey } from "../utils/focusTrap";
import { isRecord } from "../../common/isRecord";
import { renderTurnHtml } from "../transcriptMarkdown";
import type { ConversationTurn as Turn } from "../../common/conversationTurn";

const props = defineProps<{ sessionId: string | null; cwd: string | null; open: boolean }>();
const emit = defineEmits<{ (e: "close"): void }>();

const turns = ref<Turn[]>([]);
const truncated = ref(false);
const loading = ref(false);
const error = ref(false);
const isTurns = (v: unknown): v is { turns: Turn[]; truncated: boolean } => isRecord(v) && Array.isArray(v.turns);

const scrollEl = ref<HTMLElement | null>(null);
const modalEl = ref<HTMLElement | null>(null);

// Bumped per load so a slow fetch for a previously-opened session can't overwrite the
// state of a newer open.
let req = 0;
async function load(): Promise<void> {
  if (!props.sessionId) return;
  const my = ++req;
  loading.value = true;
  error.value = false;
  try {
    const params = new URLSearchParams({ session: props.sessionId });
    if (props.cwd) params.set("cwd", props.cwd);
    const res = await fetch(`/api/transcript/turns?${params.toString()}`);
    if (!res.ok) throw new Error(String(res.status));
    const data: unknown = await res.json();
    if (my !== req) return; // superseded by a newer open
    turns.value = isTurns(data) ? data.turns : [];
    truncated.value = isTurns(data) && data.truncated;
    // The newest reply is what the reader came for — start at the bottom, like the
    // terminal does, and scroll UP into history instead of down through it.
    nextTick(() => scrollEl.value?.scrollTo({ top: scrollEl.value.scrollHeight }));
  } catch {
    if (my === req) {
      error.value = true;
      turns.value = [];
      truncated.value = false;
    }
  } finally {
    if (my === req) loading.value = false;
  }
}

// Jump between REPLY boundaries — the exact motion that is painful in the raw
// terminal, where the previous reply sits an unknown number of log-lines up.
function jumpReply(direction: -1 | 1): void {
  const container = scrollEl.value;
  if (!container) return;
  const anchors = Array.from(container.querySelectorAll<HTMLElement>('[data-testid="tr-reply"]'));
  if (!anchors.length) return;
  const top = container.scrollTop;
  // The reply the viewport currently starts in (last anchor at-or-above the top edge).
  let current = -1;
  for (let i = 0; i < anchors.length; i++) {
    if (anchors[i].offsetTop <= top + 2) current = i;
  }
  const next = Math.min(anchors.length - 1, Math.max(0, current + direction));
  container.scrollTo({ top: anchors[next].offsetTop });
}

const onKeydown = (e: KeyboardEvent) => {
  if (e.key === "Escape") {
    emit("close");
    return;
  }
  if (e.key !== "Tab" || !modalEl.value) return;
  trapTabKey(e, modalEl.value);
};

watch(
  [() => props.open, () => props.sessionId, () => props.cwd],
  (vals, oldVals) => {
    const open = vals[0];
    if (!open) {
      document.removeEventListener("keydown", onKeydown);
      return;
    }
    load();
    if (!oldVals?.[0]) {
      document.addEventListener("keydown", onKeydown);
      nextTick(() => modalEl.value?.focus());
    }
  },
  { immediate: true },
);

onUnmounted(() => document.removeEventListener("keydown", onKeydown));
</script>

<template>
  <div v-if="open" class="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(0,0,0,0.45)]" @click.self="emit('close')">
    <div
      ref="modalEl"
      data-testid="tr-modal"
      class="flex max-h-[88vh] w-[min(760px,94vw)] flex-col overflow-hidden rounded-lg bg-panel text-fg shadow-[0_10px_40px_rgba(0,0,0,0.5)]"
      role="dialog"
      aria-modal="true"
      aria-label="Conversation"
      tabindex="-1"
    >
      <div class="flex items-center gap-2 border-b border-b-[color-mix(in_srgb,currentColor_15%,transparent)] px-3.5 py-2.5">
        <span class="font-semibold">会話</span>
        <span data-testid="tr-count" class="text-[0.8rem] opacity-60">{{ truncated ? "直近" : "" }}{{ turns.length }}ターン</span>
        <button
          type="button"
          data-testid="tr-prev"
          class="ml-auto cursor-pointer border-0 bg-transparent p-0.5 text-inherit opacity-70 hover:opacity-100"
          title="前の応答へ"
          aria-label="Jump to the previous reply"
          @click="jumpReply(-1)"
        >
          <span class="material-symbols-outlined" aria-hidden="true">arrow_upward</span>
        </button>
        <button
          type="button"
          data-testid="tr-next"
          class="cursor-pointer border-0 bg-transparent p-0.5 text-inherit opacity-70 hover:opacity-100"
          title="次の応答へ"
          aria-label="Jump to the next reply"
          @click="jumpReply(1)"
        >
          <span class="material-symbols-outlined" aria-hidden="true">arrow_downward</span>
        </button>
        <button
          type="button"
          data-testid="tr-refresh"
          class="cursor-pointer border-0 bg-transparent p-0.5 text-inherit opacity-70 hover:opacity-100"
          title="最新の状態に更新"
          aria-label="Refresh the conversation"
          @click="load()"
        >
          <span class="material-symbols-outlined" aria-hidden="true">refresh</span>
        </button>
        <button
          type="button"
          data-testid="tr-close"
          class="cursor-pointer border-0 bg-transparent p-0.5 text-[0.95rem] text-inherit"
          aria-label="Close the conversation view"
          @click="emit('close')"
        >
          <span class="material-symbols-outlined" aria-hidden="true">close</span>
        </button>
      </div>
      <!-- `relative` makes this the offsetParent, so jumpReply's offsetTop reads are
           relative to the SCROLL CONTAINER — without it they'd measure from the fixed
           overlay (centering gap + header included) and every jump would overshoot. -->
      <div ref="scrollEl" class="relative overflow-y-auto px-4 py-3">
        <p v-if="loading && !turns.length" data-testid="tr-empty" class="py-6 text-center opacity-60">Loading…</p>
        <p v-else-if="error" data-testid="tr-empty" class="py-6 text-center opacity-60">会話を読み込めませんでした。</p>
        <p v-else-if="turns.length === 0" data-testid="tr-empty" class="py-6 text-center opacity-60">まだ会話がありません。</p>
        <template v-else>
          <p v-if="truncated" class="m-0 pb-2 text-center text-[0.75rem] opacity-50">それより前のターンは省略</p>
          <template v-for="(turn, idx) in turns" :key="idx">
            <!-- The prompt: a compact quote, visually subordinate — it's the reader's own
                 words, kept for orientation, not the thing being read. -->
            <div
              v-if="turn.role === 'user'"
              data-testid="tr-prompt"
              class="mb-2 mt-4 whitespace-pre-wrap border-l-2 border-l-[color-mix(in_srgb,currentColor_30%,transparent)] pl-2.5 font-sans text-[0.8rem] leading-[1.5] opacity-60 first:mt-0"
            >
              {{ turn.text }}
            </div>
            <!-- eslint-disable-next-line vue/no-v-html -- LLM-authored, sanitized in renderTurnHtml -->
            <div v-else data-testid="tr-reply" class="tr-md mb-2 font-sans text-[0.86rem] leading-[1.6]" v-html="renderTurnHtml(turn.text)" />
          </template>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Markdown niceties the utility classes can't reach inside v-html content. Kept
   minimal: readable code, restrained headings, wrapped tables. */
.tr-md :deep(pre) {
  overflow-x: auto;
  border-radius: 6px;
  background: color-mix(in srgb, currentColor 8%, transparent);
  padding: 0.6em 0.8em;
  font-size: 0.92em;
}
.tr-md :deep(code) {
  font-family: ui-monospace, monospace;
}
.tr-md :deep(h1),
.tr-md :deep(h2),
.tr-md :deep(h3) {
  margin: 0.8em 0 0.3em;
  font-size: 1.05em;
}
.tr-md :deep(p),
.tr-md :deep(ul),
.tr-md :deep(ol) {
  margin: 0.4em 0;
}
.tr-md :deep(table) {
  border-collapse: collapse;
  display: block;
  overflow-x: auto;
}
.tr-md :deep(th),
.tr-md :deep(td) {
  border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
  padding: 0.2em 0.5em;
}
.tr-md :deep(blockquote) {
  margin: 0.4em 0;
  border-left: 3px solid color-mix(in srgb, currentColor 30%, transparent);
  padding-left: 0.7em;
  opacity: 0.8;
}
</style>
