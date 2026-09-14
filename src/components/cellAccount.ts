// Which claude.ai account a cell CONNECTS as (2026-09-14). One line, and the whole
// behaviour of the per-page account lives in it:
//
//   - a cell that has already launched sends its own stamp, and nothing else. A page
//     default set later must never move a conversation that is already running on other
//     credentials — the process holds its token for life, so the page could only lie.
//   - a cell with no session yet inherits its page's account. This is the ONLY path by
//     which a page default reaches a pane at all: the account rides the /ws query, and the
//     stamp is written after the server answers with a session id.
//
// Shipped first without the second clause, and every pane launched on the default login
// while its page said otherwise — invisibly, because the stamp written a moment later said
// the right thing.
// A codex cell is never in this: the account is a claude.ai login, and /ws/codex has no use
// for one — sending it would put another vendor's session on a query that reads as an
// identity it does not have.
// A FORK lands here as a cell with no session of its own, so it starts on its PAGE's account
// rather than the source pane's. Deliberate: a branch is a new conversation that happens to
// carry an old transcript, and the page it is opened on is the operator's own statement of
// which subscription it should cost.
export function cellConnectAccount(cell: { session: string | null; account?: string; agent?: "codex" }, pageAccount: string | null | undefined): string | null {
  if (cell.agent === "codex") return null;
  if (cell.account) return cell.account;
  return cell.session ? null : (pageAccount ?? null);
}
