import { ref, onMounted } from "vue";

// The toolbar's Claude account chip state, read from GET /api/claude-account. Fetched on
// mount and again whenever the dropdown opens (the identity can change under us — a login
// or logout typed into any pane), plus after every action here. Best-effort like the
// update badge: a failed read just leaves the chip blank.
export interface ClaudeAccountEntry {
  email: string;
  savedAt: string;
}

// The wording carries the operating model: with a restart the fleet moves NOW (each pane
// resumes its own conversation on the new account), and only the interrupted panes —
// working or limit-stuck — are told to carry on; without one, only new panes change.
function restartNotice(restarted: number | undefined, nudged: number | undefined, tail: string): string {
  if (typeof restarted !== "number" || restarted <= 0) return `new panes ${tail}`;
  return `restarted ${restarted} pane(s) ${tail}, auto-continued ${nudged ?? 0}`;
}

interface PostResult {
  ok: boolean;
  error?: string;
  restartedPanes?: number;
  nudgedPanes?: number;
}

function parsePostResult(resOk: boolean, status: number, data: unknown): PostResult {
  const record = (data ?? {}) as { error?: unknown; restartedPanes?: unknown; nudgedPanes?: unknown };
  const err = typeof record.error === "string" ? record.error : null;
  if (!resOk) return { ok: false, error: err ?? `HTTP ${status}` };
  return {
    ok: true,
    restartedPanes: typeof record.restartedPanes === "number" ? record.restartedPanes : undefined,
    nudgedPanes: typeof record.nudgedPanes === "number" ? record.nudgedPanes : undefined,
  };
}

export function useClaudeAccount() {
  const current = ref<string | null>(null);
  const accounts = ref<ClaudeAccountEntry[]>([]);
  const busy = ref(false);
  const error = ref<string | null>(null);
  // A one-line confirmation after an action — what happened and what to do next. Actions
  // only apply to NEW panes (a running pane keeps its token until refresh), and saying so
  // here beats letting the operator wonder why an open pane still answers as the old account.
  const notice = ref<string | null>(null);

  async function refresh(): Promise<void> {
    try {
      const res = await fetch("/api/claude-account");
      if (!res.ok) return;
      const data: unknown = await res.json();
      if (typeof data !== "object" || data === null) return;
      const record = data as { current?: unknown; accounts?: unknown };
      current.value = typeof record.current === "string" ? record.current : null;
      accounts.value = Array.isArray(record.accounts) ? record.accounts.filter((a): a is ClaudeAccountEntry => typeof a?.email === "string") : [];
    } catch {
      // best-effort — a blank chip is fine
    }
  }

  async function post(path: string, body: Record<string, unknown>): Promise<PostResult> {
    busy.value = true;
    error.value = null;
    notice.value = null;
    try {
      const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data: unknown = await res.json().catch(() => null);
      return parsePostResult(res.ok, res.status, data);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    } finally {
      busy.value = false;
      await refresh();
    }
  }

  async function switchTo(email: string, restartPanes: boolean): Promise<boolean> {
    const result = await post("/api/claude-account/switch", { email, restartPanes });
    const tail = "as " + email;
    if (result.ok) notice.value = `Switched — ${restartNotice(result.restartedPanes, result.nudgedPanes, tail)}.`;
    else error.value = result.error ?? "switch failed";
    return result.ok;
  }

  async function restartAllPanes(): Promise<boolean> {
    const result = await post("/api/claude-account/restart-panes", {});
    if (result.ok) notice.value = `Restarted ${result.restartedPanes ?? 0} pane(s) on the current account, auto-continued ${result.nudgedPanes ?? 0}.`;
    else error.value = result.error ?? "restart failed";
    return result.ok;
  }

  async function logoutForNewLogin(): Promise<boolean> {
    const result = await post("/api/claude-account/logout", {});
    if (result.ok) notice.value = "Logged out — open a new pane and claude will ask you to log in.";
    else error.value = result.error ?? "logout failed";
    return result.ok;
  }

  onMounted(() => void refresh());

  return { current, accounts, busy, error, notice, refresh, switchTo, restartAllPanes, logoutForNewLogin };
}
