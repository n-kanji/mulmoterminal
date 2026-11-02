import { describe, it, expect } from "vitest";
import { spawnFailureMessage } from "../../../server/routes/ws-routes.js";

// Before 2026-11-02 every spawn failure read "Is the `claude` CLI installed and on your PATH?",
// including the one that was really the machine out of pseudo-terminals (node-pty's fd leak,
// plans/fix-pty-fd-leak.md). The operator looked for a PATH problem that did not exist. The
// message now carries node-pty's own words, and names the exhaustion causes when it is one.
describe("spawnFailureMessage", () => {
  it("names pty/process exhaustion and the server restart that clears it for posix_spawnp", () => {
    const text = spawnFailureMessage("posix_spawnp failed.");
    expect(text).toContain("posix_spawnp failed");
    expect(text).toContain("pseudo-terminal");
    expect(text).toContain("restart the MulmoTerminal server");
    expect(text).toContain("fix-pty-perms");
    expect(text).not.toContain("PATH");
  });

  it("treats the kernel's resource errors the same way", () => {
    for (const detail of ["spawn EAGAIN", "EMFILE: too many open files", "ENFILE"]) {
      expect(spawnFailureMessage(detail)).toContain("pseudo-terminal");
    }
  });

  it("keeps the PATH hint, with the real error alongside, for anything else", () => {
    const text = spawnFailureMessage("spawn claude ENOENT");
    expect(text).toContain("spawn claude ENOENT");
    expect(text).toContain("PATH");
  });

  it("does not stack its own punctuation on the error's", () => {
    expect(spawnFailureMessage("posix_spawnp failed.")).not.toContain("failed.)");
  });
});
