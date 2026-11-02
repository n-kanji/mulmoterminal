// How many pseudo-terminal MASTER fds this process holds. node-pty 1.1.0 leaked one per spawn
// on macOS: its pty_posix_spawn opens a throwaway ptmx to push the real master above fd 2 and
// its cleanup loop never closed it (nor the slave). Nothing noticed — the pane ran, the pane
// exited, the fd stayed — until the 499th spawn met kern.tty.ptmx_max (511) and every new pane
// died with "posix_spawnp failed", which the UI then blamed on a missing `claude` CLI (operator
// report 2026-11-02; plans/fix-pty-fd-leak.md). The dependency is fixed (1.2.0-beta.18 closes
// both); this watch exists so the next leak — a node-pty regression, a new spawn path of our
// own — shows in server.log within the hour instead of after two days of silence.
//
// Counting is a /dev/fd scan plus fstat per entry: no lsof, a few milliseconds. A master is a
// character device sharing /dev/ptmx's major number (macOS `15,<n>`, Linux `5,2`); no /dev/ptmx
// (Windows) means no count, and the watch stays silent.
import fs from "node:fs";

// What macOS allows at once (sysctl kern.tty.ptmx_max). Named in the warning so the reader
// knows how far from the wall the number is.
export const PTMX_MAX_MACOS = 511;

// How many more masters than live sessions is still "transient" rather than a leak: a probe,
// a dev terminal being torn down, a spawn mid-flight. Well under the headroom, far above noise.
export const PTY_FD_LEAK_SLACK = 20;

function majorOf(rdev: number): number {
  return process.platform === "darwin" ? rdev >>> 24 : (rdev >>> 8) & 0xfff;
}

// undefined = not probed yet; null = probed, no /dev/ptmx here (the watch then stays off).
let ptmxMajor: number | null | undefined;
function ptmxMajorNumber(): number | null {
  if (ptmxMajor === undefined) {
    try {
      ptmxMajor = majorOf(fs.statSync("/dev/ptmx").rdev);
    } catch {
      ptmxMajor = null;
    }
  }
  return ptmxMajor;
}

// Null where it cannot be measured (no /dev/ptmx or no /dev/fd), never a guess.
export function countPtyMasterFds(): number | null {
  const major = ptmxMajorNumber();
  if (major === null) return null;
  let names: string[];
  try {
    names = fs.readdirSync("/dev/fd");
  } catch {
    return null;
  }
  let held = 0;
  for (const name of names) {
    const fd = Number(name);
    if (!Number.isInteger(fd)) continue;
    try {
      const st = fs.fstatSync(fd);
      if (st.isCharacterDevice() && majorOf(st.rdev) === major) held++;
    } catch {
      // closed between the readdir and the fstat, or the readdir's own handle — not ours to count
    }
  }
  return held;
}

// The server.log line when the held count has outrun the live sessions, or null while it has
// not. Pure, so the threshold is testable without a pty.
export function ptyFdLeakWarning(held: number, live: number, slack: number = PTY_FD_LEAK_SLACK): string | null {
  if (held - live <= slack) return null;
  return (
    `[pty] ${held} pseudo-terminal master fds held for ${live} live session(s) — a leak. ` +
    `macOS allows ${PTMX_MAX_MACOS} in total (kern.tty.ptmx_max); once they are gone every new pane fails with "posix_spawnp failed". ` +
    `Restarting the server releases them.`
  );
}
