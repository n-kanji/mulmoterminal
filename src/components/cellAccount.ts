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
export function cellConnectAccount(cell: { session: string | null; account?: string }, pageAccount: string | null | undefined): string | null {
  if (cell.account) return cell.account;
  return cell.session ? null : (pageAccount ?? null);
}
