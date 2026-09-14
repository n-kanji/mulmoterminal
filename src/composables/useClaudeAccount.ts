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

// When MT's own record of the default login and ~/.claude.json disagree about an account that
// has a store of its own, neither can be believed — see backends/claude-account.ts. The server
// refuses to move credentials until this is settled, so the chip has to ask.
export interface DefaultAmbiguity {
  recorded: string | null;
  onDisk: string | null;
}

const asAmbiguity = (v: unknown): DefaultAmbiguity | null => {
  const record = v as DefaultAmbiguity | null;
  if (!record || typeof record !== "object") return null;
  const pick = (x: unknown) => (typeof x === "string" ? x : null);
  return { recorded: pick(record.recorded), onDisk: pick(record.onDisk) };
};

export function useClaudeAccount() {
  const current = ref<string | null>(null);
  const ambiguous = ref<DefaultAmbiguity | null>(null);
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
      const record = data as { current?: unknown; accounts?: unknown; ambiguous?: unknown };
      current.value = typeof record.current === "string" ? record.current : null;
      ambiguous.value = asAmbiguity(record.ambiguous);
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

  // Every action reads the same way: the confirmation on success, the reason on failure — one
  // line in the menu either way, because what changed is invisible until the next pane starts.
  function report(result: PostResult, ok: string, fallback: string): boolean {
    if (result.ok) notice.value = ok;
    else error.value = result.error ?? fallback;
    return result.ok;
  }

  const switchTo = async (email: string, restartPanes: boolean): Promise<boolean> => {
    const result = await post("/api/claude-account/switch", { email, restartPanes });
    const moved = restartNotice(result.restartedPanes, result.nudgedPanes, `as ${email}`);
    return report(result, `Switched — ${moved}.`, "switch failed");
  };

  const restartAllPanes = async (): Promise<boolean> => {
    const result = await post("/api/claude-account/restart-panes", {});
    return report(result, `Restarted ${result.restartedPanes ?? 0} pane(s), auto-continued ${result.nudgedPanes ?? 0}.`, "restart failed");
  };

  // The operator settles which account the default slot holds. Nothing else can: the two
  // sources disagree and only they know which login they last typed where.
  const declareDefault = async (email: string): Promise<boolean> =>
    report(await post("/api/claude-account/default", { email }), `既定のログインを ${email} として記録しました。`, "could not record the default account");

  const logoutForNewLogin = async (): Promise<boolean> =>
    report(await post("/api/claude-account/logout", {}), "Logged out — open a new pane and claude will ask you to log in.", "logout failed");

  onMounted(() => void refresh());

  return { current, ambiguous, accounts, busy, error, notice, refresh, switchTo, restartAllPanes, logoutForNewLogin, declareDefault };
}
