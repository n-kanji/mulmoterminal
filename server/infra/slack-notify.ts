// A one-message Slack poster for the server's own alerts (login-health, 2026-10-21). The bot
// token lives in an env-style file the operator names in config (`export SLACK_BOT_TOKEN=…`
// or `SLACK_BOT_TOKEN=…` lines) — never in config.json itself, which is served to the browser.
// Read at post time, not startup: a rotated token takes effect without a restart.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const SLACK_TOKEN_VAR = "SLACK_BOT_TOKEN";

export function parseEnvFile(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const assignment = line.startsWith("export ") ? line.slice("export ".length).trimStart() : line;
    const m = /^(\w+)=(.*)$/.exec(assignment);
    if (!m) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out.set(m[1], value);
  }
  return out;
}

const expandHome = (p: string): string => (p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p);

export async function readSlackBotToken(tokenFile: string): Promise<string | null> {
  const text = await fs.readFile(expandHome(tokenFile), "utf8");
  return parseEnvFile(text).get(SLACK_TOKEN_VAR) ?? null;
}

export interface SlackPost {
  tokenFile: string;
  channel: string;
  text: string;
}

// Throws on any failure (missing token, HTTP error, Slack `ok: false`) — the caller decides
// whether that is fatal; for the login-health monitor it is logged and swallowed.
export async function postSlackMessage({ tokenFile, channel, text }: SlackPost, fetchImpl: typeof fetch = fetch): Promise<void> {
  const token = await readSlackBotToken(tokenFile);
  if (!token) throw new Error(`${SLACK_TOKEN_VAR} not found in ${tokenFile}`);
  const res = await fetchImpl("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ channel, text }),
  });
  if (!res.ok) throw new Error(`Slack HTTP ${res.status}`);
  const body = (await res.json()) as { ok?: boolean; error?: string };
  if (!body.ok) throw new Error(`Slack: ${body.error ?? "unknown error"}`);
}
