import { Server as IOServer } from "socket.io";
import type { Server as HttpServer } from "node:http";

// Minimal socket.io pub/sub, modeled on mulmoclaude's server/events/pub-sub.
// Channel names are socket.io rooms — subscribe/unsubscribe map to
// socket.join / socket.leave, and publish broadcasts to the room.
// socket.io handles reconnect / heartbeat / transport for us.
// What a module that only ANNOUNCES needs. Depending on the whole createPubSub return type
// instead means every such module — and every test fake — has to grow a method it never
// calls each time this file gains one.
export interface Publisher {
  publish(channel: string, data: unknown): void;
}

// Which ONE subscriber an action goes to: a tab the operator is looking at, if any; otherwise
// the first one, which is all there was before tabs reported themselves. Pure, so the rule can
// be tested without a socket server — it decides where an agent's column appears.
export function pickOneSubscriber(room: readonly string[], hidden: ReadonlySet<string>): string | null {
  if (room.length === 0) return null;
  return room.find((id) => !hidden.has(id)) ?? room[0];
}

export function createPubSub(server: HttpServer, isAllowedOrigin: (origin: string | undefined, remoteAddress: string | undefined) => boolean = () => true) {
  const io = new IOServer(server, {
    path: "/ws/pubsub",
    transports: ["websocket"],
    // Reject cross-origin connections so an untrusted website can't subscribe to
    // session activity. allowRequest covers the websocket handshake; cors covers
    // any polling/preflight.
    allowRequest: (req, cb) => cb(null, isAllowedOrigin(req.headers.origin, req.socket?.remoteAddress)),
    cors: {
      // Socket.IO hands this callback no request, so there is genuinely no peer to check —
      // spelled out rather than omitted. allowRequest above gates the actual handshake and
      // does see the socket, so this covers only polling/preflight.
      origin: (origin, cb) => cb(null, isAllowedOrigin(origin, undefined)),
      credentials: true,
    },
  });

  // Which tabs are actually in front of someone (operator report 2026-09-14). A tab reports
  // its own document.visibilityState on connect and whenever it changes; publishToOne uses it
  // to pick a window the operator can SEE. Sockets default to visible: a client that never
  // reports is a client that behaves the way every client behaved before this existed.
  const hidden = new Set<string>();

  io.on("connection", (socket) => {
    socket.on("subscribe", (channel) => {
      if (typeof channel === "string") socket.join(channel);
    });
    socket.on("unsubscribe", (channel) => {
      if (typeof channel === "string") socket.leave(channel);
    });
    socket.on("presence", (state) => {
      if (state === "hidden") hidden.add(socket.id);
      else if (state === "visible") hidden.delete(socket.id);
    });
    socket.on("disconnect", () => hidden.delete(socket.id));
  });

  return {
    publish(channel: string, data: unknown) {
      io.to(channel).emit("data", { channel, data });
    },
    // How many sockets are in the room. A publish is fire-and-forget, so a caller that
    // NEEDS someone to act on the message (the phone asking the grid to open a terminal,
    // #831) has to check first — otherwise "no browser is open" is indistinguishable from
    // success, and the phone reports a launch that never happened.
    subscriberCount(channel: string): number {
      return io.sockets.adapter.rooms.get(channel)?.size ?? 0;
    },
    // Deliver to exactly ONE subscriber, and say whether anyone got it.
    //
    // `publish` broadcasts, which is right for the channels that announce a fact — a dir's
    // config changed, a session became active — since every tab reacting is the point and
    // reacting twice costs nothing. A message that asks for an ACTION is the opposite: with
    // two MulmoTerminal tabs open, a broadcast would have each of them open a terminal, so
    // one tap on the phone spawns as many PTYs as there are tabs.
    // Which ONE gets it: a tab the operator is looking at, if any.
    //
    // It used to be whichever socket the room happened to list first, which is insertion
    // order — so a MulmoTerminal left open in a background window (or a browser some other
    // tool drove) collected every column an agent asked for, and the operator watched nothing
    // appear in the window in front of them. "It opened SOMEWHERE" is the worst outcome here:
    // the session starts, the work happens, and there is no sign of it.
    publishToOne(channel: string, data: unknown): boolean {
      const room = [...(io.sockets.adapter.rooms.get(channel) ?? [])];
      const target = pickOneSubscriber(room, hidden);
      if (target === null) return false;
      if (room.length > 1) console.log(`[pubsub] ${channel} -> 1 of ${room.length} subscribers (${hidden.has(target) ? "none visible" : "visible"})`);
      io.to(target).emit("data", { channel, data });
      return true;
    },
  };
}
