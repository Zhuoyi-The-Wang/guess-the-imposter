const { createServer } = require("http");
const { Server } = require("socket.io");
const fs   = require("fs");
const path = require("path");
require("dotenv").config();

// ─── Fallback word list ───────────────────────────────────────────────────────
const FALLBACK_WORDS = [
  "Sushi", "Casino", "Surfing", "Telescope", "Platypus",
  "Sauna", "Karaoke", "Accordion", "Narwhal", "Fondue",
  "Lighthouse", "Skydiving", "Periscope", "Axolotl", "Paella",
  "Submarine", "Falconry", "Theremin", "Capybara", "Igloo",
  "Circus", "Jousting", "Sextant", "Quokka", "Bouldering",
];

// ─── Local word list ──────────────────────────────────────────────────────────
const WORDS_FILE = path.resolve(__dirname, "words.txt");

function loadAllWords() {
  try {
    const raw   = fs.readFileSync(WORDS_FILE, "utf8");
    const words = raw.split("\n").map(w => w.trim()).filter(Boolean);
    if (words.length === 0) throw new Error("words.txt is empty");
    console.log(`[words] Loaded ${words.length} words from words.txt`);
    return words;
  } catch (e) {
    console.warn(`[words] Could not read words.txt (${e.message}) -- using built-in fallback`);
    return [...FALLBACK_WORDS];
  }
}

function generateWordList() {
  const all = loadAllWords();
  return shuffle([...all]).slice(0, Math.min(25, all.length));
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function genCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// ─── In-memory state ──────────────────────────────────────────────────────────
// Identity is name+roomCode. No deviceId anywhere.
//
// room.players: Map<playerName, { name, socketId, score }>
// room.hostName:    name of the host
// room.imposterId:  name of the imposter (this round)
// room.startPlayer: name of the starting player (this round)
// room.roles:       Map<playerName, roleData> — kept for mid-round rejoin
const rooms      = new Map();
const socketToRoom = new Map(); // Map<socketId, { code, name }>

// ─── Room serialisation ───────────────────────────────────────────────────────
// id === name so the client can do room.hostId === myId, player.id === myId, etc.
function getPublicRoom(room) {
  const reveal = room.phase === "results" || room.phase === "scoreboard";
  return {
    code:        room.code,
    hostId:      room.hostName,
    phase:       room.phase,
    players:     Array.from(room.players.values()).map(p => ({
      id: p.name, name: p.name, score: p.score,
    })),
    startPlayer: room.startPlayer,
    winner:      room.winner,
    winReason:   room.winReason,
    imposterId:  reveal ? room.imposterId : null,
    revealWord:  reveal ? room.word       : null,
    roundNum:    room.roundNum,
    wordsLeft:   room.wordQueue.length,
  };
}

function broadcastRoom(io, room) {
  io.to(room.code).emit("room:update", getPublicRoom(room));
}

function nextWord(room) {
  if (room.wordQueue.length > 0) return room.wordQueue.shift();
  console.warn(`[room ${room.code}] Word queue empty -- using fallback`);
  return FALLBACK_WORDS[Math.floor(Math.random() * FALLBACK_WORDS.length)];
}

function beginRound(io, room) {
  const names      = Array.from(room.players.keys());
  room.word        = nextWord(room);
  room.imposterId  = names[Math.floor(Math.random() * names.length)];
  room.startPlayer = names[Math.floor(Math.random() * names.length)];
  room.phase       = "playing";
  room.winner      = null;
  room.winReason   = null;
  room.roundNum   += 1;
  room.roles       = new Map();

  for (const [name, player] of room.players) {
    const isImposter = name === room.imposterId;
    const roleData   = { isImposter, word: isImposter ? null : room.word, startPlayer: room.startPlayer };
    room.roles.set(name, roleData);
    if (player.socketId) io.to(player.socketId).emit("game:role", roleData);
  }

  broadcastRoom(io, room);
}

function scheduleWordGeneration(io, room) {
  const words    = generateWordList();
  room.wordQueue  = words;
  room.wordsReady = true;
  console.log(`[room ${room.code}] Word queue ready (${words.length} words)`);
  io.to(room.code).emit("room:wordsReady", { wordsLeft: words.length });
}

// ─── HTTP + Socket.io ─────────────────────────────────────────────────────────
const httpServer = createServer((req, res) => {
  if (req.url === "/health") { res.writeHead(200); res.end("OK"); return; }
  res.writeHead(404); res.end("Not found");
});

const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map(s => s.trim())
  : "*";

const io = new Server(httpServer, {
  cors: { origin: ALLOWED_ORIGINS, methods: ["GET", "POST"] },
});

io.on("connection", (socket) => {
  let currentName = null;
  let currentRoom = null;

  function attachSocket(room, name) {
    const player = room.players.get(name);
    if (player) player.socketId = socket.id;
    currentName = name;
    currentRoom = room.code;
    socket.join(room.code);
    socketToRoom.set(socket.id, { code: room.code, name });
  }

  // ── room:create ───────────────────────────────────────────────────────────
  socket.on("room:create", ({ name } = {}, cb) => {
    if (!name?.trim()) return cb?.({ error: "Name required" });
    const n = name.trim();

    let code;
    do { code = genCode(); } while (rooms.has(code));

    const room = {
      code, hostName: n,
      players:    new Map([[n, { name: n, socketId: socket.id, score: 0 }]]),
      phase:      "lobby",
      word: null, imposterId: null, startPlayer: null,
      winner: null, winReason: null, roundNum: 0,
      wordQueue: [], wordsReady: false, roles: new Map(),
    };

    rooms.set(code, room);
    attachSocket(room, n);
    cb?.({ code });
    broadcastRoom(io, room);
    scheduleWordGeneration(io, room);
  });

  // ── room:join ─────────────────────────────────────────────────────────────
  // Unified: handles fresh joins, tab-close rejoins, and mid-round spectators.
  socket.on("room:join", ({ name, code } = {}, cb) => {
    if (!name?.trim()) return cb?.({ error: "Name required" });
    const n    = name.trim();
    const norm = String(code || "").toUpperCase().trim();
    const room = rooms.get(norm);
    if (!room) return cb?.({ error: "Room not found" });

    const existing = room.players.get(n);

    if (existing) {
      // Returning player — check no one else is live on this name
      const liveDupe = existing.socketId &&
        existing.socketId !== socket.id &&
        io.sockets.sockets.has(existing.socketId);
      if (liveDupe) return cb?.({ error: "Someone with that name is already connected" });

      attachSocket(room, n);
      broadcastRoom(io, room);

      const restoredRole = (room.phase === "playing" || room.phase === "results")
        ? (room.roles.get(n) ?? null) : null;
      return cb?.({ role: restoredRole });
    }

    // New player
    if (room.players.size >= 12) return cb?.({ error: "Room is full (max 12)" });
    room.players.set(n, { name: n, socketId: socket.id, score: 0 });
    attachSocket(room, n);
    broadcastRoom(io, room);

    if (room.phase === "playing") {
      socket.emit("game:spectate");
      return cb?.({ spectating: true });
    }
    cb?.({});
  });

  // ── room:rejoin ───────────────────────────────────────────────────────────
  // Silent socket-reconnect path (wifi drop, phone sleep).
  socket.on("room:rejoin", ({ name, code } = {}, cb) => {
    if (!name?.trim()) return cb?.({ error: "Name required" });
    const n    = name.trim();
    const norm = String(code || "").toUpperCase().trim();
    const room = rooms.get(norm);
    if (!room) return cb?.({ error: "Room not found" });

    const player = room.players.get(n);
    if (!player) return cb?.({ error: "Not in this room" });

    attachSocket(room, n);
    broadcastRoom(io, room);

    const restoredRole = (room.phase === "playing" || room.phase === "results")
      ? (room.roles.get(n) ?? null) : null;
    if (restoredRole) return cb?.({ role: restoredRole });
    if (room.phase === "playing") { socket.emit("game:spectate"); return cb?.({ spectating: true }); }
    cb?.({});
  });

  // ── game:start ────────────────────────────────────────────────────────────
  socket.on("game:start", ({} = {}, cb) => {
    const room = rooms.get(currentRoom);
    if (!room)                         return cb?.({ error: "Room not found" });
    if (room.hostName !== currentName) return cb?.({ error: "Only the host can start" });
    if (room.players.size < 2)         return cb?.({ error: "Need at least 2 players" });
    if (!room.wordsReady)              return cb?.({ error: "Words not ready yet, try again in a moment" });
    if (room.wordQueue.length === 0)   return cb?.({ error: "No words left -- reset the game to get a new set" });
    beginRound(io, room);
    cb?.({ ok: true });
  });

  // ── game:declare ──────────────────────────────────────────────────────────
  socket.on("game:declare", ({ winner } = {}, cb) => {
    const room = rooms.get(currentRoom);
    if (!room)                         return cb?.({ error: "Room not found" });
    if (room.hostName !== currentName) return cb?.({ error: "Only the host can declare" });
    if (room.phase !== "playing")      return cb?.({ error: "Not in playing phase" });
    if (winner !== "players" && winner !== "imposter") return cb?.({ error: "Invalid winner" });

    room.winner = winner;
    if (winner === "players") {
      for (const [n, p] of room.players) { if (n !== room.imposterId) p.score += 1; }
      room.winReason = `${room.imposterId} was the imposter! All other players earn 1 point.`;
    } else {
      const imp = room.players.get(room.imposterId);
      if (imp) imp.score += 3;
      room.winReason = `${room.imposterId} fooled everyone and earns 3 points!`;
    }

    room.phase = "results";
    broadcastRoom(io, room);
    cb?.({ ok: true });
  });

  // ── game:nextRound ────────────────────────────────────────────────────────
  socket.on("game:nextRound", ({} = {}, cb) => {
    const room = rooms.get(currentRoom);
    if (!room)                         return cb?.({ error: "Room not found" });
    if (room.hostName !== currentName) return cb?.({ error: "Only the host can advance" });
    if (room.wordQueue.length === 0)   return cb?.({ error: "No words left -- end the game to see scores" });
    beginRound(io, room);
    cb?.({ ok: true });
  });

  // ── game:end ──────────────────────────────────────────────────────────────
  socket.on("game:end", ({} = {}, cb) => {
    const room = rooms.get(currentRoom);
    if (!room)                         return cb?.({ error: "Room not found" });
    if (room.hostName !== currentName) return cb?.({ error: "Only the host can end" });
    room.phase = "scoreboard";
    broadcastRoom(io, room);
    cb?.({ ok: true });
  });

  // ── game:reset ────────────────────────────────────────────────────────────
  socket.on("game:reset", ({} = {}, cb) => {
    const room = rooms.get(currentRoom);
    if (!room)                         return cb?.({ error: "Room not found" });
    if (room.hostName !== currentName) return cb?.({ error: "Only the host can reset" });

    room.phase = "lobby";
    room.word = null; room.imposterId = null; room.startPlayer = null;
    room.winner = null; room.winReason = null; room.roundNum = 0;
    room.wordQueue = []; room.wordsReady = false; room.roles = new Map();
    for (const p of room.players.values()) p.score = 0;

    broadcastRoom(io, room);
    cb?.({ ok: true });
    scheduleWordGeneration(io, room);
  });

  // ── room:leave ────────────────────────────────────────────────────────────
  socket.on("room:leave", ({} = {}, cb) => {
    const name = currentName;
    const code = currentRoom;
    if (!name || !code) return cb?.({ ok: true });

    const room = rooms.get(code);
    if (!room) return cb?.({ ok: true });

    room.players.delete(name);
    socketToRoom.delete(socket.id);
    currentName = null;
    currentRoom = null;
    socket.leave(code);

    if (room.players.size === 0) {
      rooms.delete(code);
    } else {
      if (room.hostName === name) room.hostName = room.players.keys().next().value;
      broadcastRoom(io, room);
    }
    cb?.({ ok: true });
  });

  // ── disconnect ────────────────────────────────────────────────────────────
  socket.on("disconnect", () => {
    const name = currentName;
    const code = currentRoom;
    socketToRoom.delete(socket.id);
    if (!name || !code) return;

    setTimeout(() => {
      const room = rooms.get(code);
      if (!room) return;
      const player = room.players.get(name);
      if (!player) return;
      if (player.socketId !== socket.id) return; // reconnected elsewhere

      room.players.delete(name);
      if (room.players.size === 0) { rooms.delete(code); return; }
      if (room.hostName === name) room.hostName = room.players.keys().next().value;
      broadcastRoom(io, room);
    }, 15_000);
  });
});

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => console.log(`Socket.io server running on port ${PORT}`));
