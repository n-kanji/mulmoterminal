import { ref, computed, onMounted, onUnmounted } from "vue";
import { alertingSlots, type LoginHealthReport, type LoginSlot } from "../../common/loginHealth";

// The toolbar's login-expiry warning (2026-10-21), read from GET /api/claude-account/health —
// the server's hourly scan of every Claude Code login this machine holds. Unlike the update
// badge this CHANGES over time (a day passes, a /login lands), so it is polled on a fixed
// interval for the life of the page, not a few times at mount. Best-effort: a failed read
// keeps the last report rather than flashing the warning off and on.
const POLL_MS = 10 * 60_000;

export function useLoginHealth() {
  const report = ref<LoginHealthReport | null>(null);
  const checking = ref(false);
  const alerting = computed<LoginSlot[]>(() => (report.value ? alertingSlots(report.value) : []));
  // Dead outranks expiring for the chip's colour; the lines list both.
  const worst = computed<LoginSlot | null>(() => alerting.value[0] ?? null);

  function take(data: unknown): void {
    const record = data as { report?: LoginHealthReport | null } | null;
    if (record && typeof record === "object" && "report" in record) report.value = record.report ?? null;
  }

  async function fetchOnce(): Promise<void> {
    try {
      const res = await fetch("/api/claude-account/health");
      if (res.ok) take(await res.json());
    } catch {
      // best-effort — keep what we have
    }
  }

  // Scan now: the operator ran /login and wants the warning gone, not in an hour.
  async function recheck(): Promise<void> {
    if (checking.value) return;
    checking.value = true;
    try {
      const res = await fetch("/api/claude-account/health", { method: "POST" });
      if (res.ok) take(await res.json());
    } catch {
      // best-effort
    } finally {
      checking.value = false;
    }
  }

  let timer: ReturnType<typeof setInterval> | undefined;
  onMounted(() => {
    void fetchOnce();
    timer = setInterval(() => void fetchOnce(), POLL_MS);
  });
  onUnmounted(() => {
    if (timer) clearInterval(timer);
  });

  return { report, alerting, worst, checking, recheck };
}
