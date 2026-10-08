// The Reader (plans/reader-view.md): one inbox for the annotated HTML briefs Claude writes
// for the operator. Both sides read these shapes — the Express routes under /api/reader
// answer with them, the /reader view renders them, and `viewhtml` (the operator's CLI)
// posts to them and then opens /reader?doc=<path> in a new browser tab.
//
// Fork-local. MulmoClaude has no counterpart: the briefs and their comment layer are the
// operator's own html-summary skill, not a shared package.
import { isRecord } from "./isRecord.js";

/** Where a brief stands, derived from the file and the read log — never set by hand.
 *  - unread: never opened in the reader, no comments (nothing says the operator saw it)
 *  - awaiting: the operator wrote comments Claude has not marked applied — waiting on Claude
 *  - done: opened, or every comment carries the skill's "反映済み" marker
 *  Three states, not four (operator, 2026-09-11): "read with nothing to say" and "all
 *  comments applied" are the same thing to the operator — finished. */
export type ReaderDocState = "unread" | "awaiting" | "done";

export interface ReaderDoc {
  /** Absolute path on disk — the identity of the doc. */
  path: string;
  title: string;
  /** Last-modified, ms epoch — moves when a comment is saved. */
  mtime: number;
  /** Created, ms epoch (the file's birth time; the modified time where the filesystem has
   *  none). The order the briefs were WRITTEN in, which is what "what came in while I was
   *  reading" means — a save does not move it. */
  createdAt: number;
  /** Grouping: the root the doc was found under, the project inside it, the folder inside
   *  the project ("" for a doc at the project root). */
  root: string;
  project: string;
  folder: string;
  /** Comment counts: all, and those not yet marked applied. */
  comments: number;
  open: number;
  readAt: number | null;
  state: ReaderDocState;
}

export interface ReaderIndex {
  docs: ReaderDoc[];
  roots: string[];
}

/** A live session the reader can type into (POST /api/reader/send). `working` mirrors
 *  the broadcast candidate: undefined is NOT idle. */
export interface ReaderPane {
  id: string;
  cwd: string;
  agent: string;
  working: boolean | undefined;
}

/** There is deliberately NO "show this doc in the open reader tab" channel. Until
 *  2026-10-08 `viewhtml` POSTed /open and the host pushed the path to the one subscribed tab,
 *  so a new brief never added a tab. The operator reads several briefs side by side —
 *  four tabs parked to come back to — and the push kept replacing one of them, so what was
 *  parked to read was gone before it was read. A brief now always opens in a NEW tab
 *  (viewhtml: /register, then /reader?doc= through the OS opener). The pile-up this was
 *  meant to prevent is the operator's to manage; losing a parked page is not. */

/** The message the comment layer's bridge posts to the reader (window.postMessage). The
 *  bridge is injected by the server when it serves a doc (server/reader/reader-doc.ts). */
export type ReaderBridgeMessage = { type: "reader:save"; html: string } | { type: "reader:copy"; text: string } | { type: "reader:ready" };

export const readerBridgeMessageOf = (data: unknown): ReaderBridgeMessage | null => {
  if (!isRecord(data)) return null;
  if (data.type === "reader:save" && typeof data.html === "string") return { type: "reader:save", html: data.html };
  if (data.type === "reader:copy" && typeof data.text === "string") return { type: "reader:copy", text: data.text };
  if (data.type === "reader:ready") return { type: "reader:ready" };
  return null;
};

/** Derive the state from the counts and the read log. */
export function readerDocState(comments: number, open: number, readAt: number | null): ReaderDocState {
  if (open > 0) return "awaiting";
  return readAt || comments > 0 ? "done" : "unread";
}
