import { ref, onMounted } from "vue";

// The toolbar's Claude account chip state, read from GET /api/claude-account. Fetched on
// mount and again whenever the dropdown opens (the identity can change under us — a login
// or logout typed into any pane), plus after every action here. Best-effort like the
// update badge: a failed read just leaves the chip blank.
export interface ClaudeAccountEntry {
  email: string;
  savedAt: string;
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

  async function post(path: string, body: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
    busy.value = true;
    error.value = null;
    notice.value = null;
    try {
      const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data: unknown = await res.json().catch(() => null);
      const err = typeof (data as { error?: unknown } | null)?.error === "string" ? (data as { error: string }).error : null;
      if (!res.ok) return { ok: false, error: err ?? `HTTP ${res.status}` };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    } finally {
      busy.value = false;
      await refresh();
    }
  }

  async function switchTo(email: string): Promise<boolean> {
    const result = await post("/api/claude-account/switch", { email });
    if (result.ok) notice.value = `Switched — new panes run as ${email}.`;
    else error.value = result.error ?? "switch failed";
    return result.ok;
  }

  async function logoutForNewLogin(): Promise<boolean> {
    const result = await post("/api/claude-account/logout", {});
    if (result.ok) notice.value = "Logged out — open a new pane and claude will ask you to log in.";
    else error.value = result.error ?? "logout failed";
    return result.ok;
  }

  onMounted(() => void refresh());

  return { current, accounts, busy, error, notice, refresh, switchTo, logoutForNewLogin };
}
