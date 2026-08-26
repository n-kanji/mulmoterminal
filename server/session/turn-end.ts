// "A session just finished a turn" as an event other modules can listen for. Until the
// next-instruction queue there was no server-side consumer for that moment — the Stop hook
// updated flags and published, and that was it — so hook-routes.ts emits it here rather than
// growing another dependency in HookDeps for every future listener.
//
// Emitted AFTER the Stop hook has committed `working=false`: a listener that types into the
// pane relies on that (terminalInput's Ctrl-C clear only rides along when the flag says the
// pane is idle).
type TurnEndListener = (sessionId: string) => void | Promise<void>;

const listeners = new Set<TurnEndListener>();

export function onTurnEnd(listener: TurnEndListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Run every listener; a failing one is logged, never rethrown into the hook response. */
export async function emitTurnEnd(sessionId: string): Promise<void> {
  for (const listener of listeners) {
    try {
      await listener(sessionId);
    } catch (err) {
      console.error(`[turn-end] listener failed for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
