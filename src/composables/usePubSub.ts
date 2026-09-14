import { io, type Socket } from "socket.io-client";

// Minimal pub/sub client, modeled on mulmoclaude's usePubSub. A single shared
// socket multiplexes every channel; subscriptions are replayed on reconnect.
interface PubSubMessage {
  channel: string;
  data: unknown;
}

type Callback = (data: unknown) => void;
type Unsubscribe = () => void;

let socket: Socket | null = null;
const listeners = new Map<string, Set<Callback>>();
// Fired on every RE-connect (not the first connect). A subscriber that holds derived
// state — e.g. the notification list — re-syncs here, since pubsub only replays room
// membership on reconnect, not the events missed while disconnected.
const reconnectListeners = new Set<() => void>();
let hasConnected = false;

// Tell the server whether this tab is in front of anyone (operator report 2026-09-14). A
// message that asks for an ACTION — open a column, open a terminal — goes to exactly one tab,
// and without this it went to whichever one the room listed first: a window left open behind
// everything else would quietly collect every column an agent opened, and the operator saw
// nothing appear in front of them.
function reportPresence(sock: Socket): void {
  if (sock.connected) sock.emit("presence", document.visibilityState === "hidden" ? "hidden" : "visible");
}

function connect(): Socket {
  if (socket) return socket;

  const sock = io({ path: "/ws/pubsub", transports: ["websocket"] });

  // Re-emit every live subscription so rooms survive a reconnect.
  sock.on("connect", () => {
    for (const channel of listeners.keys()) sock.emit("subscribe", channel);
    reportPresence(sock);
    if (hasConnected) for (const cb of reconnectListeners) cb();
    hasConnected = true;
  });

  sock.on("data", (msg: PubSubMessage) => {
    const cbs = listeners.get(msg.channel);
    if (cbs) for (const handler of cbs) handler(msg.data);
  });

  document.addEventListener("visibilitychange", () => reportPresence(sock));
  socket = sock;
  return sock;
}

export function usePubSub() {
  function subscribe(channel: string, callback: Callback): Unsubscribe {
    let entry = listeners.get(channel);
    if (!entry) {
      entry = new Set();
      listeners.set(channel, entry);
    }
    entry.add(callback);

    const sock = connect();
    if (sock.connected) sock.emit("subscribe", channel);

    return () => {
      const cbs = listeners.get(channel);
      if (!cbs) return;
      cbs.delete(callback);
      if (cbs.size === 0) {
        listeners.delete(channel);
        if (socket?.connected) socket.emit("unsubscribe", channel);
      }
    };
  }

  // Register a callback fired on every reconnect (not the first connect). Returns an
  // unsubscribe. Lets a consumer re-fetch authoritative state after a dropped socket.
  function onReconnect(callback: () => void): Unsubscribe {
    reconnectListeners.add(callback);
    connect();
    return () => reconnectListeners.delete(callback);
  }

  return { subscribe, onReconnect };
}
