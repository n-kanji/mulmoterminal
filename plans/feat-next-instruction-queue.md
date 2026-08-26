# Per-pane "next instructions" queue (operator request 2026-08-26)

## Why

The operator runs 15-24 columns. Mid-turn interruptions ("oh, and also do X") drift the
running turn, so the ask is: park the instruction on the pane and deliver it when the pane
is waiting for input.

The operator's second point is the hard requirement: **auto-delivery must not hide the
report the pane just finished.** If item N+1 is typed the moment turn N ends, the operator
walks back to the desk and only sees the reply to N+1; the reply to N is gone from the
screen. So every automatic hand-off records the exchange it superseded, and the pane shows
it as unread until the operator has read it.

## Shape

Server (`server/session/next-queue.ts`, persisted at `~/.mulmoterminal/next-queue.json`,
mission-store pattern):

```
{ [sessionId]: { auto: boolean, items: [{id,text,at}], handoffs: [{id,text,sentAt,prevPrompt,prevReply,read}], updatedAt } }
```

- `POST /api/session/:id/queue` `{text}` — enqueue (agent in the pane may enqueue its own;
  aliased id resolved like the mission route).
- `GET /api/session/:id/queue` — state.
- `DELETE /api/session/:id/queue/:itemId`, `PUT .../queue/auto {enabled}`,
  `POST .../queue/send-next`, `POST .../queue/read`.
- Drain: `hook-routes.ts` emits a turn-end (`server/session/turn-end.ts`) after the Stop
  hook has committed `working=false`; `next-queue-drain.ts` takes the head item, reads the
  session's last exchange from the transcript (`sessionLastTurn`, full text; falls back to
  the 400-char `lastResponses`), stores the hand-off, then types the item through the same
  sender the phone / broadcast use (paste + delayed Enter, per-session serialised).
- Every change publishes `next-queue` `{id, state}` to all browsers.

UI: `NextQueueMenu.vue` in the cell header actions. Badge = queued count, plus an accent
badge for unread hand-offs. Popover: unread hand-offs first (the superseded reply, then
"-> sent: ..."), then the queue (textarea, list, auto toggle, send now).

## Known limits

- The sender collapses all whitespace, so a multi-line instruction arrives as one line.
- Claude only: the Stop hook is Claude's. Codex panes get no button.
- One queue per grid session id; a `/clear` inside the pane keeps the same queue (aliasing).
