// One conversation turn — the wire shape of GET /api/transcript/turns and the unit the
// transcript readers produce. Lives in common/ because both sides decide from it: the
// server extracts turns from Claude's JSONL (server/session/transcript.ts) and the
// reading view renders them (src/components/TranscriptOverlay.vue).
export interface ConversationTurn {
  role: "user" | "assistant";
  text: string;
}
