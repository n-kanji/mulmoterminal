// Side-effect module: imported FIRST by server/index.ts so that even log lines written while
// the other modules load (plugin registry, config) carry a timestamp. Kept apart from
// log-timestamps.ts so the pure functions can be unit-tested without touching the real console.
import { installLogTimestamps } from "./log-timestamps.js";

installLogTimestamps(console);
