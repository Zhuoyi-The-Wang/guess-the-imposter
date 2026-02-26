// server.js
const { createServer } = require("http");
const { Server } = require("socket.io");

// ─── Word List ────────────────────────────────────────────────────────────────
const WORD_CATEGORIES = {
  Food:       ["Sushi", "Pizza", "Tacos", "Ramen", "Burger", "Croissant", "Dumpling", "Gelato", "Fondue", "Paella"],
  Places:     ["Airport", "Library", "Casino", "Hospital", "Submarine", "Space Station", "Circus", "Sauna", "Lighthouse", "Igloo"],
  Activities: ["Surfing", "Skydiving", "Meditation", "Karaoke", "Archery", "Scuba Diving", "Bouldering", "Fencing", "Falconry", "Jousting"],
  Objects:    ["Telescope", "Accordion", "Periscope", "Metronome", "Kaleidoscope", "Theremin", "Compass", "Abacus", "Sextant", "Sundial"],
  Animals:    ["Platypus", "Axolotl", "Narwhal", "Pangolin", "Quokka", "Capybara", "Mantis Shrimp", "Okapi", "Blobfish", "Tardigrade"],
};

function pickWord() {
  const cats = Object.values(WORD_CATEGORIES);
  const cat  = cats[Math.floor(Math.random() * cats.length)];
  return cat[Math.floor(Math.random() * cat.length)];
}

function genCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// ─── In-memory state ──────────────────────────────────────────────────────────
const rooms = new Map();

function getPublicRoom(room) {
  return {
    code:          room.code,
    hostId:        room.hostId,
    phase:         room.phase,
    players:       Array.from(room.players.values()),
    startPlayer:   room.startPlayer,
    votes:         Object.fromEntries(room.votes),
    winner:        room.winner,
    winReason:     room.winReason,
    imposterGuess: room.imposterGuess,
    imposterId:    room.phase === "results" ? room.imposterId : null,
  };
}

function broadcastRoom(io, room) {
  io.to(room.code).emit("room:update", getPublicRoom(room));
}

function resolveVote(io, room) {
  const tally = new Map();
  for (const targetId of room.votes.values()) {
    tally.set(targetId, (tally.get(targetId) || 0) + 1);
  }
  let maxVotes = 0, eliminated = null;
  for (const [pid, count] of tally) {
    if (count > maxVotes) { maxVotes = count; eliminated = pid; }
  }
  const name = room.players.get(eliminated)?.name ?? "Someone";
  if (eliminated === room.imposterId) {
    room.winner    = "players";
    room.winReason = `${name} was the imposter! Players win!`;
  } else {
    room.winner    = "imposter";
    room.winReason = `${name} was voted out, but wasn't the imposter. Imposter wins!`;
  }
  room.phase = "results";
  broadcastRoom(io, room);
}

// ─── HTTP + Socket.io server ──────────────────────────────────────────────────
const httpServer = createServer((req, res) => {
  // Basic health check endpoint so Railway knows the service is alive
  if (req.url === "/health") {
    res.writeHead(200);
    res.end("OK");
    return;
  }
  res.writeHead(404);
  res.end("Not found");
});

const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map(s => s.trim())
  : "*";

const io = new Server(httpServer, {
  cors: {
    origin: ALLOWED_ORIGINS,
    methods: ["GET", "POST"],
  },
});

io.on("connection", (socket) => {
  let currentRoom = null;

  socket.on("room:create", ({ name }, cb) => {
    if (!name?.trim()) return cb?.({ error: "Name required" });
    let code;
    do { code = genCode(); } while (rooms.has(code));
    const room = {
      code, hostId: socket.id,
      players: new Map([[socket.id, { id: socket.id, name: name.trim() }]]),
      phase: "lobby", word: null, imposterId: null,
      startPlayer: null, votes: new Map(),
      imposterGuess: null, winner: null, winReason: null,
    };
    rooms.set(code, room);
    currentRoom = code;
    socket.join(code);
    cb?.({ code });
    broadcastRoom(io, room);
  });

  socket.on("room:join", ({ name, code }, cb) => {
    const normalized = String(code || "").toUpperCase().trim();
    const room = rooms.get(normalized);
    if (!name?.trim())           return cb?.({ error: "Name required" });
    if (!room)                   return cb?.({ error: "Room not found" });
    if (room.phase !== "lobby")  return cb?.({ error: "Game already started" });
    if (room.players.size >= 12) return cb?.({ error: "Room is full (max 12)" });
    room.players.set(socket.id, { id: socket.id, name: name.trim() });
    currentRoom = normalized;
    socket.join(normalized);
    cb?.({ code: normalized });
    broadcastRoom(io, room);
  });

  socket.on("room:sync", ({ code }, cb) => {
    const room = rooms.get(String(code).toUpperCase());
    if (!room) return cb?.({ error: "Room not found" });
    if (room.players.has(socket.id)) {
      currentRoom = String(code).toUpperCase();
      socket.join(currentRoom);
    }
    cb?.({ room: getPublicRoom(room) });
  });

  socket.on("game:start", (_, cb) => {
    const room = rooms.get(currentRoom);
    if (!room)                     return cb?.({ error: "Room not found" });
    if (room.hostId !== socket.id) return cb?.({ error: "Only the host can start" });
    if (room.players.size < 2)     return cb?.({ error: "Need at least 2 players" });
    const ids        = Array.from(room.players.keys());
    room.word        = pickWord();
    room.imposterId  = ids[Math.floor(Math.random() * ids.length)];
    room.startPlayer = ids[Math.floor(Math.random() * ids.length)];
    room.phase       = "playing";
    room.votes       = new Map();
    room.winner      = null; room.winReason = null; room.imposterGuess = null;
    for (const [sid] of room.players) {
      const isImposter = sid === room.imposterId;
      io.to(sid).emit("game:role", {
        isImposter,
        word:        isImposter ? null : room.word,
        startPlayer: room.startPlayer,
      });
    }
    broadcastRoom(io, room);
    cb?.({ ok: true });
  });

  socket.on("vote:open", (_, cb) => {
    const room = rooms.get(currentRoom);
    if (!room)                    return cb?.({ error: "Room not found" });
    if (room.phase !== "playing") return cb?.({ error: "Not in playing phase" });
    room.phase = "voting"; room.votes = new Map();
    broadcastRoom(io, room); cb?.({ ok: true });
  });

  socket.on("vote:cast", ({ targetId }, cb) => {
    const room = rooms.get(currentRoom);
    if (!room)                       return cb?.({ error: "Room not found" });
    if (room.phase !== "voting")     return cb?.({ error: "Not voting phase" });
    if (!room.players.has(targetId)) return cb?.({ error: "Invalid target" });
    if (targetId === socket.id)      return cb?.({ error: "Can't vote yourself" });
    room.votes.set(socket.id, targetId);
    broadcastRoom(io, room);
    if (room.votes.size === room.players.size) resolveVote(io, room);
    cb?.({ ok: true });
  });

  socket.on("imposter:guess", ({ guess }, cb) => {
    const room = rooms.get(currentRoom);
    if (!room)                         return cb?.({ error: "Room not found" });
    if (room.imposterId !== socket.id) return cb?.({ error: "Not the imposter" });
    if (room.phase !== "playing")      return cb?.({ error: "Can only guess during play" });
    const norm    = s => s.toLowerCase().replace(/[^a-z]/g, "");
    const correct = norm(guess) === norm(room.word);
    room.imposterGuess = guess; room.phase = "results";
    room.winner    = correct ? "imposter" : "players";
    room.winReason = correct
      ? `The imposter correctly guessed "${room.word}"! Imposter wins!`
      : `The imposter guessed wrong ("${guess}"). The word was "${room.word}". Players win!`;
    broadcastRoom(io, room);
    cb?.({ ok: true, correct });
  });

  socket.on("game:reset", (_, cb) => {
    const room = rooms.get(currentRoom);
    if (!room)                     return cb?.({ error: "Room not found" });
    if (room.hostId !== socket.id) return cb?.({ error: "Only host can reset" });
    room.phase = "lobby"; room.word = null; room.imposterId = null;
    room.startPlayer = null; room.votes = new Map();
    room.winner = null; room.winReason = null; room.imposterGuess = null;
    broadcastRoom(io, room); cb?.({ ok: true });
  });

  socket.on("disconnect", () => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    room.players.delete(socket.id);
    if (room.players.size === 0) { rooms.delete(currentRoom); return; }
    if (room.hostId === socket.id) room.hostId = room.players.keys().next().value;
    if (room.imposterId === socket.id && room.phase === "playing") {
      room.phase = "results"; room.winner = "players";
      room.winReason = "The imposter disconnected. Players win!";
    }
    broadcastRoom(io, room);
  });
});

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  console.log(`Socket.io server running on port ${PORT}`);
});
