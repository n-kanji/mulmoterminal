import { describe, it, expect } from "vitest";
import { parseEnvFile, postSlackMessage } from "../../../server/infra/slack-notify.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("parseEnvFile", () => {
  it("reads plain, exported, quoted and commented lines", () => {
    const m = parseEnvFile(["# comment", "export SLACK_BOT_TOKEN=xoxb-1", "OTHER='a b'", 'Q="c"', "export   SPACED=v", "junk line", ""].join("\n"));
    expect(m.get("SLACK_BOT_TOKEN")).toBe("xoxb-1");
    expect(m.get("OTHER")).toBe("a b");
    expect(m.get("Q")).toBe("c");
    expect(m.get("SPACED")).toBe("v");
    expect(m.has("junk")).toBe(false);
  });
});

describe("postSlackMessage", () => {
  const tokenFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mt-slack-")), "secrets.env");
  fs.writeFileSync(tokenFile, "export SLACK_BOT_TOKEN=xoxb-test\n");

  it("posts with the file's token and throws on Slack's ok:false", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;
    await postSlackMessage({ tokenFile, channel: "C1", text: "hi" }, fetchImpl);
    expect(calls[0].url).toBe("https://slack.com/api/chat.postMessage");
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer xoxb-test");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ channel: "C1", text: "hi" });

    const refusing = (async () => new Response(JSON.stringify({ ok: false, error: "channel_not_found" }), { status: 200 })) as unknown as typeof fetch;
    await expect(postSlackMessage({ tokenFile, channel: "C1", text: "hi" }, refusing)).rejects.toThrow("channel_not_found");
  });

  it("throws when the file has no token", async () => {
    const empty = path.join(path.dirname(tokenFile), "empty.env");
    fs.writeFileSync(empty, "# nothing\n");
    await expect(postSlackMessage({ tokenFile: empty, channel: "C1", text: "x" })).rejects.toThrow("SLACK_BOT_TOKEN");
  });
});
