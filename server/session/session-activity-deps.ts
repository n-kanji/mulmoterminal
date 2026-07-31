// What a route needs in order to report on a live session: its working / needs-attention
// flags, and the header prompt + AI title that ride along with them.
//
// The hook route is the only thing that CALLS these, but app-routes.ts has to declare them
// too — index.ts owns the implementations and hands them down — so the contract is named
// once here rather than restated on both sides (#826).
import type { WaitKind } from "../../common/paneState.js";

export interface SessionActivityDeps {
  setWorking: (id: string, working: boolean, event?: string) => void;
  /** `waitKind` splits a Notification into approval vs question (common/paneState). Absent
   *  for every other caller, which is why it is optional rather than a fourth positional
   *  everyone has to pass null to. */
  setWaiting: (id: string, waiting: boolean, event?: string, waitKind?: WaitKind | null) => void;
  publishActivity: (id: string) => void;
  forgetTitle: (id: string) => void;
  noteTitleTurn: (id: string, prompt: string) => void;
  /** Feed the live turn's tool names, so the published status can say planning vs editing (#727). */
  noteWorkPhase: (id: string, event: string, toolName?: string) => void;
  maybeGenerateTitle: (id: string, cwd: string | undefined) => Promise<void>;
}
