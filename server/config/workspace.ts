import { statSync } from "node:fs";
import path from "node:path";
import { CLAUDE_CWD } from "./env.js";

// The same validation WITHOUT a fallback: the path itself when it is an absolute, existing
// directory, else null. A route that was handed a project to act in has to refuse an
// unusable path rather than act in the default workspace — opening an agent's column
// somewhere other than where it asked is worse than saying no (server/routes/agent-routes.ts).
export function existingDir(cwd: string): string | null {
  if (!path.isAbsolute(cwd)) return null;
  try {
    return statSync(cwd).isDirectory() ? cwd : null;
  } catch {
    // not a dir / doesn't exist
    return null;
  }
}

// Validate a client-supplied workspace dir: must be an absolute, existing
// directory. Anything else (relative, missing, a file) falls back to CLAUDE_CWD,
// so a cell can launch a terminal in a chosen dir without trusting raw input.
export function resolveWorkspace(cwd: string | null): string {
  return (cwd && existingDir(cwd)) || CLAUDE_CWD;
}

// Every `?cwd=` route resolves the same way: a string query param or the default
// workspace. Shared so a route can't accidentally skip the validation above.
export function workspaceFromQuery(cwd: unknown): string {
  return resolveWorkspace(typeof cwd === "string" ? cwd : null);
}
