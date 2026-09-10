// The Reader (plans/reader-view.md): one inbox for the annotated HTML briefs Claude writes
// for the operator. Both sides read these shapes — the Express routes under /api/reader
// answer with them, the /reader view renders them, and `viewhtml` (the operator's CLI)
// posts to them.
//
// Fork-local. MulmoClaude has no counterpart: the briefs and their comment layer are the
// operator's own html-summary skill, not a shared package.
import { isRecord } from "./isRecord.js";

/** Where a brief stands, derived from the file and the read log — never set by hand.
 *  - unread: never opened in the reader
 *  - read: opened, no comments
 *  - commented: has comments Claude has not marked as applied
 *  - done: every comment carries the skill's "反映済み" marker */
export type ReaderDocState = "unread" | "read" | "commented" | "done";

export interface ReaderDoc {
  /** Absolute path on disk — the identity of the doc. */
  path: string;
  title: string;
  /** Last-modified, ms epoch (the sort key). */
  mtime: number;
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

/** The pub/sub channel an open reader tab listens on: `viewhtml` asks the host to show a
 *  doc, and the host hands the request to ONE tab (the same one-subscriber rule as
 *  AGENT_COLUMN_CHANNEL) rather than opening a new browser tab per brief — the tab pile-up
 *  is the problem the reader exists to end. */
export const READER_OPEN_CHANNEL = "reader-open";

export interface ReaderOpenEvent {
  path: string;
}

export const readerOpenEventOf = (data: unknown): ReaderOpenEvent | null => {
  if (!isRecord(data)) return null;
  return typeof data.path === "string" && data.path ? { path: data.path } : null;
};

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
  if (comments > 0) return open > 0 ? "commented" : "done";
  return readAt ? "read" : "unread";
}
