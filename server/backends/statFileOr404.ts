import fs from "node:fs";
import type { Request, Response } from "express";
import { respondFileError } from "../files/errorDoc.js";

// Stat `abs` for the raw file-serving routes, sending a 404 for a missing entry
// or a non-file — as a readable page for a browser navigation, JSON for code
// (respondFileError). Returns the stat, or null after the response is sent — so
// the caller does `if (!stat) return;`.
export function statFileOr404(req: Request, res: Response, abs: string): fs.Stats | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    respondFileError(req, res, 404, "not found", abs);
    return null;
  }
  if (!stat.isFile()) {
    respondFileError(req, res, 404, "not a file", abs);
    return null;
  }
  return stat;
}
