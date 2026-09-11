<script setup lang="ts">
// The reader (plans/reader-view.md): one inbox for the annotated HTML briefs Claude writes
// for the operator. Left, the briefs grouped project / folder with a derived state each;
// right, the brief itself in an iframe, its own comment layer working as it always has.
//
// The page is loaded from the OTHER loopback host name (readerDocOrigin), so it has a real
// origin for its localStorage draft yet cannot touch this app. Everything it needs from us
// arrives over postMessage through the bridge the server injects: a save (we write the
// block back through the API — no Finder drag), and a "copy for Claude" (we offer to type
// it into the pane that owns the folder).
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { ReaderDoc, ReaderDocState, ReaderPane } from "../../common/readerApi";
import { READER_OPEN_CHANNEL, readerBridgeMessageOf, readerOpenEventOf } from "../../common/readerApi";
import { useReader, readerGoto } from "../composables/useReader";
import { useEscapeToClose } from "../composables/useEscapeToClose";
import { usePubSub } from "../composables/usePubSub";
import {
  annotationsJsonOf,
  fetchReaderIndex,
  fetchReaderPanes,
  markReaderApplied,
  markReaderRead,
  markReaderReadMany,
  markReaderUnread,
  readerDocOrigin,
  readerDocUrl,
  rescanReader,
  revealInFinder,
  saveReaderAnnotations,
  sendToReaderPane,
} from "../readerApi";

const { isOpen, docPath, close } = useReader();
useEscapeToClose(isOpen, close);

// ---- the index -------------------------------------------------------------------
const docs = ref<ReaderDoc[]>([]);
const roots = ref<string[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
type Filter = "all" | "unread" | "awaiting" | "done";
const filter = ref<Filter>("all");
const query = ref("");
const collapsed = ref(new Set<string>());

// How the index is laid out (operator request 2026-09-11). Briefs arrive from many panes
// at once, so the default is one flat list in the order they were written — the grouped
// view hid a new brief under a folder further down. Both choices are remembered per
// browser; a reader that comes back the way it was left is the point of remembering.
type View = "recent" | "grouped";
type SortKey = "created" | "modified";
const VIEW_KEY = "reader:view";
const SORT_KEY = "reader:sort";
const remembered = (key: string, allowed: readonly string[], fallback: string): string => {
  try {
    const v = localStorage.getItem(key);
    return v && allowed.includes(v) ? v : fallback;
  } catch {
    return fallback;
  }
};
const view = ref<View>(remembered(VIEW_KEY, ["recent", "grouped"], "recent") as View);
const sortKey = ref<SortKey>(remembered(SORT_KEY, ["created", "modified"], "created") as SortKey);
watch([view, sortKey], ([v, k]) => {
  try {
    localStorage.setItem(VIEW_KEY, v);
    localStorage.setItem(SORT_KEY, k);
  } catch {
    // per-browser convenience only
  }
});
const timeOf = (doc: ReaderDoc): number => (sortKey.value === "created" ? doc.createdAt : doc.mtime);
/** The flat list: every matching brief, newest first by the chosen clock. */
const recent = computed<ReaderDoc[]>(() => docs.value.filter(matches).sort((a, b) => timeOf(b) - timeOf(a)));
const placeLabel = (doc: ReaderDoc): string => (doc.folder ? `${doc.project || rootLabel(doc.root)} / ${doc.folder}` : doc.project || rootLabel(doc.root));

async function refreshIndex(): Promise<void> {
  loading.value = true;
  try {
    const index = await fetchReaderIndex();
    docs.value = index.docs;
    roots.value = index.roots;
    error.value = null;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

const matches = (doc: ReaderDoc): boolean => {
  if (filter.value !== "all" && doc.state !== filter.value) return false;
  const q = query.value.trim().toLowerCase();
  if (!q) return true;
  return `${doc.title} ${doc.project} ${doc.folder} ${doc.path}`.toLowerCase().includes(q);
};

interface FolderGroup {
  folder: string;
  docs: ReaderDoc[];
}
interface ProjectGroup {
  key: string;
  project: string;
  folders: FolderGroup[];
  unread: number;
  open: number;
  latest: number;
}

// Two levels, project then folder, newest project first. One level is not enough: on the
// operator's machine a single project holds nearly every brief, and its folders are what
// map to the panes.
const groups = computed<ProjectGroup[]>(() => {
  const byProject = new Map<string, ProjectGroup>();
  for (const doc of docs.value) {
    if (!matches(doc)) continue;
    const key = `${doc.root}::${doc.project}`;
    let group = byProject.get(key);
    if (!group) {
      group = { key, project: doc.project || rootLabel(doc.root), folders: [], unread: 0, open: 0, latest: 0 };
      byProject.set(key, group);
    }
    let folder = group.folders.find((f) => f.folder === doc.folder);
    if (!folder) {
      folder = { folder: doc.folder, docs: [] };
      group.folders.push(folder);
    }
    folder.docs.push(doc);
    if (doc.state === "unread") group.unread += 1;
    group.open += doc.open;
    group.latest = Math.max(group.latest, timeOf(doc));
  }
  const out = [...byProject.values()];
  for (const g of out) {
    for (const f of g.folders) f.docs.sort((a, b) => timeOf(b) - timeOf(a));
    g.folders.sort((a, b) => timeOf(b.docs[0]) - timeOf(a.docs[0]));
  }
  out.sort((a, b) => b.latest - a.latest);
  return out;
});

const rootLabel = (root: string): string => root.split("/").filter(Boolean).pop() ?? root;
const counts = computed(() => ({
  all: docs.value.length,
  unread: docs.value.filter((d) => d.state === "unread").length,
  awaiting: docs.value.filter((d) => d.state === "awaiting").length,
  done: docs.value.filter((d) => d.state === "done").length,
}));
const filterLabel: Record<Filter, string> = { all: "All", unread: "Unread", awaiting: "Awaiting Claude", done: "Done" };

// Read state is the operator's to correct: a brief the reader called read can go back to
// unread, and everything currently shown can be swept read at once.
const shown = computed<ReaderDoc[]>(() => (view.value === "recent" ? recent.value : groups.value.flatMap((g) => g.folders.flatMap((f) => f.docs))));
async function toggleRead(doc: ReaderDoc): Promise<void> {
  try {
    const r = doc.readAt ? await markReaderUnread(doc.path) : await markReaderRead(doc.path);
    replaceDoc(r.doc);
  } catch (e) {
    showToast(e instanceof Error ? e.message : String(e), "err");
  }
}
async function markApplied(doc: ReaderDoc): Promise<void> {
  try {
    const r = await markReaderApplied(doc.path);
    replaceDoc(r.doc);
    if (r.changed) {
      showToast("Comments marked applied.");
      if (docPath.value === doc.path) reloads.value += 1;
    }
  } catch (e) {
    showToast(e instanceof Error ? e.message : String(e), "err");
  }
}
async function markShownRead(): Promise<void> {
  const paths = shown.value.filter((d) => !d.readAt).map((d) => d.path);
  if (!paths.length) return;
  try {
    const r = await markReaderReadMany(paths);
    showToast(`${r.changed} marked read.`);
    await refreshIndex();
  } catch (e) {
    showToast(e instanceof Error ? e.message : String(e), "err");
  }
}

function toggleProject(key: string): void {
  const next = new Set(collapsed.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  collapsed.value = next;
}

const rescanning = ref(false);
const rescanNote = ref<string | null>(null);
async function rescan(): Promise<void> {
  rescanning.value = true;
  rescanNote.value = null;
  try {
    const r = await rescanReader();
    rescanNote.value = `${r.found} briefs, ${r.added} new`;
    await refreshIndex();
  } catch (e) {
    rescanNote.value = e instanceof Error ? e.message : String(e);
  } finally {
    rescanning.value = false;
  }
}

// ---- the open doc ------------------------------------------------------------------
const frame = ref<HTMLIFrameElement | null>(null);
const docOrigin = readerDocOrigin(window.location);
const current = computed<ReaderDoc | null>(() => (docPath.value ? (docs.value.find((d) => d.path === docPath.value) ?? null) : null));
const frameSrc = computed(() => (docPath.value ? readerDocUrl(docOrigin, docPath.value) : ""));
// Bumped to remount the iframe on the same src (a cross-origin frame cannot be told to reload).
const reloads = ref(0);
const docDir = computed(() => (docPath.value ? docPath.value.slice(0, docPath.value.lastIndexOf("/")) : ""));

function replaceDoc(doc: ReaderDoc): void {
  const i = docs.value.findIndex((d) => d.path === doc.path);
  if (i >= 0) docs.value.splice(i, 1, doc);
  else docs.value.unshift(doc);
}

function select(doc: ReaderDoc): void {
  readerGoto(doc.path);
}

const toast = ref<{ text: string; kind: "ok" | "err" } | null>(null);
let toastTimer: ReturnType<typeof setTimeout> | null = null;
function showToast(text: string, kind: "ok" | "err" = "ok"): void {
  toast.value = { text, kind };
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.value = null), kind === "ok" ? 2500 : 8000);
}

// ---- the bridge --------------------------------------------------------------------
const saving = ref(false);
async function onBridgeSave(html: string): Promise<void> {
  const path = docPath.value;
  if (!path) return;
  const json = annotationsJsonOf(html);
  if (json === null) {
    showToast("The page sent no comment block; nothing written.", "err");
    return;
  }
  saving.value = true;
  try {
    const r = await saveReaderAnnotations(path, json);
    replaceDoc(r.doc);
    showToast("Comments saved to the file.");
    // The operator may have moved to another brief while the write was in flight: the ack
    // (which clears the page's draft and unload guard) and the remount are for the saved
    // page only — never the one on screen now.
    if (docPath.value !== path) return;
    frame.value?.contentWindow?.postMessage({ type: "reader:saved", path }, docOrigin);
    // Restart the page from the file it just wrote (its own unsaved state is stale now); the
    // bridge has cleared the unload guard and keeps the scroll position across the reload.
    setTimeout(() => (reloads.value += 1), 400);
  } catch (e) {
    showToast(`Save failed: ${e instanceof Error ? e.message : String(e)}`, "err");
  } finally {
    saving.value = false;
  }
}

function onMessage(e: MessageEvent): void {
  if (!frame.value || e.source !== frame.value.contentWindow) return;
  const msg = readerBridgeMessageOf(e.data);
  if (!msg) return;
  if (msg.type === "reader:save") void onBridgeSave(msg.html);
  else if (msg.type === "reader:copy") {
    sendText.value = msg.text;
    void openSend();
  }
}

// ---- send to pane --------------------------------------------------------------------
const sendOpen = ref(false);
const sendText = ref("");
const panes = ref<ReaderPane[]>([]);
const target = ref<string | null>(null);
const sending = ref(false);

// The panes that own this doc's folder: cwd is the folder or an ancestor of it, nearest
// first. Everything else is listed after, so a doc can still go to any pane.
const paneChoices = computed(() => {
  const dir = docDir.value;
  const owns = (p: ReaderPane): number => (dir === p.cwd || dir.startsWith(`${p.cwd}/`) ? p.cwd.length : -1);
  return [...panes.value].sort((a, b) => owns(b) - owns(a) || a.cwd.localeCompare(b.cwd)).map((p) => ({ ...p, owns: owns(p) >= 0 }));
});
const paneLabel = (p: ReaderPane): string => {
  const dir = p.cwd.split("/").filter(Boolean).pop() ?? p.cwd;
  const agent = p.agent === "claude" ? "" : ` (${p.agent})`;
  return `${dir} · ${p.id.slice(0, 8)}${agent}`;
};

async function openSend(): Promise<void> {
  sendOpen.value = true;
  try {
    panes.value = (await fetchReaderPanes()).panes;
    const first = paneChoices.value.find((p) => p.owns && p.working === false) ?? paneChoices.value.find((p) => p.owns) ?? paneChoices.value[0];
    target.value = first?.id ?? null;
  } catch (e) {
    showToast(e instanceof Error ? e.message : String(e), "err");
  }
}

async function send(): Promise<void> {
  if (!target.value || !sendText.value.trim()) return;
  sending.value = true;
  try {
    await sendToReaderPane(target.value, sendText.value);
    showToast("Sent to the pane.");
    sendOpen.value = false;
  } catch (e) {
    showToast(`Send failed: ${e instanceof Error ? e.message : String(e)}`, "err");
  } finally {
    sending.value = false;
  }
}

async function reveal(): Promise<void> {
  if (!docDir.value) return;
  try {
    await revealInFinder(docDir.value);
  } catch (e) {
    showToast(e instanceof Error ? e.message : String(e), "err");
  }
}

// Opening a doc marks it read. Declared after every ref it touches: with `immediate`, the
// watcher runs during setup, and a ref declared further down would still be in its TDZ.
watch(
  docPath,
  async (path) => {
    toast.value = null;
    sendOpen.value = false;
    if (!path) return;
    try {
      const r = await markReaderRead(path);
      replaceDoc(r.doc);
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
    }
  },
  { immediate: true },
);

// ---- lifecycle -------------------------------------------------------------------------
// `viewhtml` asks the host to show a brief; the host hands it to ONE subscriber. This
// component is mounted in every tab, so the subscription is held ONLY while the reader is
// open — otherwise the grid tab, connected first, would take the event and be navigated
// off the terminals (review of 16fcc53c). The index is also re-read whenever the tab comes
// back into view and on a slow timer, since Claude marks comments applied by editing the
// files underneath us.
let unsubscribeOpen: (() => void) | null = null;
watch(
  isOpen,
  (open) => {
    if (open && !unsubscribeOpen) {
      unsubscribeOpen = usePubSub().subscribe(READER_OPEN_CHANNEL, (data) => {
        const event = readerOpenEventOf(data);
        if (!event) return;
        void refreshIndex().then(() => readerGoto(event.path));
        window.focus();
      });
    } else if (!open && unsubscribeOpen) {
      unsubscribeOpen();
      unsubscribeOpen = null;
    }
  },
  { immediate: true },
);
let timer: ReturnType<typeof setInterval> | null = null;
const onVisible = (): void => {
  if (!document.hidden && isOpen.value) void refreshIndex();
};
onMounted(() => {
  window.addEventListener("message", onMessage);
  document.addEventListener("visibilitychange", onVisible);
  timer = setInterval(() => {
    if (isOpen.value && !document.hidden) void refreshIndex();
  }, 30_000);
});
onBeforeUnmount(() => {
  window.removeEventListener("message", onMessage);
  document.removeEventListener("visibilitychange", onVisible);
  if (timer) clearInterval(timer);
  unsubscribeOpen?.();
});
watch(
  isOpen,
  (open) => {
    if (open) void refreshIndex();
  },
  { immediate: true },
);

const stateDot: Record<ReaderDocState, string> = {
  unread: "bg-accent",
  awaiting: "bg-amber",
  done: "bg-transparent border border-border",
};
const stateTitle: Record<ReaderDocState, string> = {
  unread: "Unread",
  awaiting: "You commented; Claude has not applied it yet",
  done: "Done — read, or every comment applied",
};
const when = (ms: number): string => {
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  const year = sameYear ? "" : `${d.getFullYear()}/`;
  const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return `${year}${d.getMonth() + 1}/${d.getDate()} ${hhmm}`;
};
</script>

<template>
  <div v-if="isOpen" class="fixed inset-x-0 top-10 bottom-0 z-50 flex bg-deep" role="region" aria-label="Reader">
    <!-- Index -->
    <aside class="flex w-[320px] flex-none flex-col border-r border-border bg-panel">
      <div class="flex flex-none flex-col gap-2 border-b border-border px-3 py-2">
        <div class="flex items-center gap-2">
          <span class="text-[14px] font-[650] text-fg">Reader</span>
          <span class="text-[11px] text-muted">{{ counts.all }} briefs</span>
          <span class="flex-auto" />
          <button
            type="button"
            class="h-[24px] cursor-pointer rounded-md border border-border bg-base px-2 text-[11px] text-secondary enabled:hover:bg-hover enabled:hover:text-fg disabled:cursor-default disabled:opacity-50"
            :disabled="!shown.some((d) => !d.readAt)"
            title="Mark every brief shown in the list read"
            @click="markShownRead"
          >
            Mark shown read
          </button>
          <button
            type="button"
            class="h-[24px] cursor-pointer rounded-md border border-border bg-base px-2 text-[11px] text-secondary enabled:hover:bg-hover enabled:hover:text-fg disabled:cursor-default disabled:opacity-50"
            :disabled="rescanning"
            title="Walk the roots for briefs written before the reader existed, or moved by hand (slow)"
            @click="rescan"
          >
            {{ rescanning ? "Scanning…" : "Rescan" }}
          </button>
        </div>
        <div class="flex gap-1" role="tablist" aria-label="Filter">
          <button
            v-for="f in ['all', 'unread', 'awaiting', 'done'] as Filter[]"
            :key="f"
            type="button"
            role="tab"
            :aria-selected="filter === f"
            class="rounded-md border-0 px-2 py-0.5 text-[11.5px]"
            :class="filter === f ? 'cursor-default bg-accent-bg text-on-accent' : 'cursor-pointer bg-transparent text-muted hover:bg-hover hover:text-fg'"
            @click="filter = f"
          >
            {{ filterLabel[f] }} <span class="opacity-70">{{ counts[f] }}</span>
          </button>
        </div>
        <div class="flex items-center gap-1 text-[11.5px]">
          <div class="flex rounded-md border border-border" role="tablist" aria-label="Layout">
            <button
              v-for="v in ['recent', 'grouped'] as View[]"
              :key="v"
              type="button"
              role="tab"
              :aria-selected="view === v"
              class="border-0 px-2 py-0.5 first:rounded-l-md last:rounded-r-md"
              :class="view === v ? 'cursor-default bg-accent-bg text-on-accent' : 'cursor-pointer bg-transparent text-muted hover:bg-hover hover:text-fg'"
              :title="v === 'recent' ? 'One list, newest first, whatever the folder' : 'Grouped by project and folder'"
              @click="view = v"
            >
              {{ v === "recent" ? "Recent" : "By project" }}
            </button>
          </div>
          <span class="flex-auto" />
          <label class="text-muted" for="reader-sort">Sort</label>
          <select id="reader-sort" v-model="sortKey" class="h-[22px] rounded-md border border-border bg-base px-1 text-[11.5px] text-fg">
            <option value="created">Written (newest)</option>
            <option value="modified">Updated (newest)</option>
          </select>
        </div>
        <input
          v-model="query"
          type="search"
          placeholder="Search titles and folders"
          class="h-[26px] w-full rounded-md border border-border bg-base px-2 text-[12px] text-fg placeholder:text-muted focus:border-accent focus:outline-none"
        />
        <p v-if="rescanNote" class="m-0 text-[11px] text-secondary">{{ rescanNote }}</p>
        <p v-if="error" class="m-0 text-[11px] text-amber">{{ error }}</p>
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto">
        <p v-if="!loading && !docs.length" class="px-3 py-8 text-center text-[12px] text-muted">
          No briefs yet. Claude registers each one it writes; press Rescan to find the ones written before.
        </p>
        <template v-if="view === 'recent'">
          <button
            v-for="d in recent"
            :key="d.path"
            type="button"
            class="flex w-full cursor-pointer items-start gap-2 border-0 border-b border-border px-3 py-1.5 text-left"
            :class="d.path === docPath ? 'bg-accent-bg/60' : 'bg-transparent hover:bg-hover'"
            :title="d.path"
            @click="select(d)"
          >
            <span class="mt-[5px] h-[8px] w-[8px] flex-none rounded-full" :class="stateDot[d.state]" :title="stateTitle[d.state]" />
            <span class="min-w-0 flex-1">
              <span class="block truncate text-[12.5px] leading-snug" :class="d.state === 'unread' ? 'font-[650] text-fg' : 'text-fg'">{{ d.title }}</span>
              <span class="block truncate text-[10.5px] text-muted">
                {{ when(timeOf(d)) }} · {{ placeLabel(d)
                }}<template v-if="d.comments"> · {{ d.open ? `${d.open} to apply` : `${d.comments} applied` }}</template>
              </span>
            </span>
          </button>
        </template>
        <section v-for="g in view === 'grouped' ? groups : []" :key="g.key" class="border-b border-border">
          <button
            type="button"
            class="flex w-full cursor-pointer items-center gap-1.5 border-0 bg-transparent px-3 py-1.5 text-left hover:bg-hover"
            :aria-expanded="!collapsed.has(g.key)"
            @click="toggleProject(g.key)"
          >
            <span class="material-symbols-outlined text-[16px] text-muted">{{ collapsed.has(g.key) ? "chevron_right" : "expand_more" }}</span>
            <span class="min-w-0 flex-1 truncate text-[12.5px] font-[650] text-fg">{{ g.project }}</span>
            <span v-if="g.unread" class="rounded-full bg-accent-bg px-1.5 text-[10.5px] font-semibold text-on-accent" :title="`${g.unread} unread`">{{
              g.unread
            }}</span>
            <span v-if="g.open" class="rounded-full bg-amber/20 px-1.5 text-[10.5px] font-semibold text-amber" :title="`${g.open} comments to apply`">{{
              g.open
            }}</span>
          </button>
          <template v-if="!collapsed.has(g.key)">
            <div v-for="f in g.folders" :key="f.folder" class="pb-1">
              <div v-if="f.folder" class="px-3 pt-1 font-mono text-[10.5px] uppercase tracking-wide text-muted">{{ f.folder }}</div>
              <button
                v-for="d in f.docs"
                :key="d.path"
                type="button"
                class="flex w-full cursor-pointer items-start gap-2 border-0 px-3 py-1.5 text-left"
                :class="d.path === docPath ? 'bg-accent-bg/60' : 'bg-transparent hover:bg-hover'"
                :title="d.path"
                @click="select(d)"
              >
                <span class="mt-[5px] h-[8px] w-[8px] flex-none rounded-full" :class="stateDot[d.state]" :title="stateTitle[d.state]" />
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-[12.5px] leading-snug" :class="d.state === 'unread' ? 'font-[650] text-fg' : 'text-fg'">{{ d.title }}</span>
                  <span class="block text-[10.5px] text-muted">
                    {{ when(timeOf(d)) }}<template v-if="d.comments"> · {{ d.open ? `${d.open} to apply` : `${d.comments} applied` }}</template>
                  </span>
                </span>
              </button>
            </div>
          </template>
        </section>
      </div>
    </aside>

    <!-- Doc -->
    <div class="relative flex min-w-0 flex-1 flex-col">
      <header v-if="docPath" class="flex flex-none items-center gap-2 border-b border-border bg-panel px-3 py-1.5">
        <span class="min-w-0 truncate text-[13px] font-[650] text-fg" :title="docPath">{{ current?.title ?? docPath.split("/").pop() }}</span>
        <span class="hidden min-w-0 truncate font-mono text-[10.5px] text-muted lg:inline" :title="docPath">{{ docPath.replace(/^\/Users\/[^/]+/, "~") }}</span>
        <span class="flex-auto" />
        <span v-if="saving" class="text-[11px] text-secondary">Saving…</span>
        <button
          v-if="current && current.open > 0"
          type="button"
          class="h-[24px] cursor-pointer rounded-md border border-border bg-base px-2 text-[11px] text-secondary enabled:hover:bg-hover enabled:hover:text-fg"
          title="Every comment here is handled: mark them applied so the brief leaves Awaiting"
          @click="markApplied(current)"
        >
          Mark applied
        </button>
        <button
          v-if="current"
          type="button"
          class="h-[24px] cursor-pointer rounded-md border border-border bg-base px-2 text-[11px] text-secondary enabled:hover:bg-hover enabled:hover:text-fg"
          :title="current.readAt ? 'Put this brief back in the unread pile' : 'Mark this brief read'"
          @click="toggleRead(current)"
        >
          {{ current.readAt ? "Mark unread" : "Mark read" }}
        </button>
        <button
          type="button"
          class="h-[24px] cursor-pointer rounded-md border border-border bg-base px-2 text-[11px] text-secondary enabled:hover:bg-hover enabled:hover:text-fg"
          title="Reveal the folder in Finder"
          @click="reveal"
        >
          Finder
        </button>
        <button
          type="button"
          class="h-[24px] cursor-pointer rounded-md border border-accent bg-accent-bg px-2 text-[11px] text-on-accent enabled:hover:bg-hover enabled:hover:text-fg"
          title="Type text into the pane that owns this folder"
          @click="openSend"
        >
          Send to pane
        </button>
        <button
          type="button"
          class="h-[24px] cursor-pointer rounded-md border border-border bg-base px-2 text-[11px] text-secondary enabled:hover:bg-hover enabled:hover:text-fg"
          title="Close the reader (Esc)"
          @click="close"
        >
          Close
        </button>
      </header>
      <div v-if="sendOpen" class="flex flex-none flex-col gap-2 border-b border-border bg-base px-3 py-2">
        <div class="flex items-center gap-2">
          <label class="text-[11.5px] text-secondary" for="reader-send-target">To</label>
          <select id="reader-send-target" v-model="target" class="h-[24px] rounded-md border border-border bg-panel px-1 text-[12px] text-fg">
            <option v-for="p in paneChoices" :key="p.id" :value="p.id" :disabled="p.working !== false">
              {{ paneLabel(p) }}{{ p.owns ? "" : " — other folder" }}{{ p.working === false ? "" : " (busy)" }}
            </option>
          </select>
          <span v-if="!paneChoices.length" class="text-[11.5px] text-muted">No live pane on this host.</span>
          <span class="flex-auto" />
          <button
            type="button"
            class="h-[24px] cursor-pointer rounded-md border border-border bg-panel px-2 text-[11px] text-secondary hover:bg-hover hover:text-fg"
            @click="sendOpen = false"
          >
            Cancel
          </button>
          <button
            type="button"
            class="h-[24px] cursor-pointer rounded-md border border-accent bg-accent-bg px-2 text-[11px] text-on-accent enabled:hover:bg-hover disabled:cursor-default disabled:opacity-50"
            :disabled="sending || !target || !sendText.trim()"
            @click="send"
          >
            {{ sending ? "Sending…" : "Send" }}
          </button>
        </div>
        <textarea
          v-model="sendText"
          rows="4"
          class="w-full resize-y rounded-md border border-border bg-panel px-2 py-1 font-mono text-[12px] text-fg focus:border-accent focus:outline-none"
          placeholder="What to type into the pane. The page's Copy-for-Claude button fills this in."
        />
      </div>
      <iframe
        v-if="frameSrc"
        ref="frame"
        :key="`${frameSrc}#${reloads}`"
        :src="frameSrc"
        class="min-h-0 w-full flex-1 border-0 bg-white"
        sandbox="allow-scripts allow-same-origin allow-modals"
        allow="clipboard-write"
        title="Brief"
      />
      <div v-else class="flex flex-1 items-center justify-center text-[13px] text-muted">Pick a brief on the left.</div>
      <Transition
        enter-active-class="transition-opacity duration-200"
        leave-active-class="transition-opacity duration-200"
        enter-from-class="opacity-0"
        leave-to-class="opacity-0"
      >
        <div
          v-if="toast"
          class="pointer-events-none absolute left-1/2 top-3 z-20 -translate-x-1/2 rounded-lg px-4 py-2 text-[12.5px] font-semibold shadow-[0_4px_16px_rgba(0,0,0,0.35)]"
          :class="toast.kind === 'ok' ? 'bg-accent-bg text-on-accent' : 'bg-amber text-[#1a1a2e]'"
          role="status"
        >
          {{ toast.text }}
        </div>
      </Transition>
    </div>
  </div>
</template>
