const { createServer } = require("http");
const { Server } = require("socket.io");
const https = require("https");
require("dotenv").config();

// ─── Fallback word list (used if OpenAI call fails) ───────────────────────────
const FALLBACK_WORDS = [
  "Sushi", "Casino", "Surfing", "Telescope", "Platypus",
  "Sauna", "Karaoke", "Accordion", "Narwhal", "Fondue",
  "Lighthouse", "Skydiving", "Periscope", "Axolotl", "Paella",
  "Submarine", "Falconry", "Theremin", "Capybara", "Igloo",
  "Circus", "Jousting", "Sextant", "Quokka", "Bouldering",
];

// ─── OpenAI word generation ───────────────────────────────────────────────────
async function generateWordList() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.warn("[words] No OPENAI_API_KEY set — using fallback list");
    return shuffle([...FALLBACK_WORDS]);
  }

  const now      = new Date();
  const nonce    = Math.random().toString(36).slice(2, 8);
  const timeHint = now.toLocaleString("en-US", { weekday: "long", month: "long", hour: "numeric", hour12: true });

  const prompt = `You are generating secret words for a social deduction party game called "Guess the Imposter".

Rules for good words:
- Concrete nouns or activities (things people can describe without giving the word away)
- Interesting, specific, and a little unexpected — not generic like "dog" or "car"
- Mix of categories: foods, places, activities, objects, animals, professions, phenomena
- Each word should be instantly recognisable but have enough interesting details to spark questions
- Avoid anything offensive, violent, or NSFW

Seed info (use this to vary your output): time is ${timeHint}, nonce is ${nonce}.

Return EXACTLY 25 words as a JSON array of strings. No extra text, no numbering, no markdown. Example format:
["Word1","Word2","Word3"]`;

  return new Promise((resolve) => {
    const body = JSON.stringify({
      model:       "gpt-4o-mini",
      max_tokens:  300,
      temperature: 1.1,
      messages:    [{ role: "user", content: prompt }],
    });

    const req = https.request(
      {
        hostname: "api.openai.com",
        path:     "/v1/chat/completions",
        method:   "POST",
        headers:  {
          "Content-Type":   "application/json",
          "Authorization":  `Bearer ${apiKey}`,
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks = [];

        res.on("data", (chunk) => chunks.push(chunk));

        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");

          // Non-200 responses (bad key, quota exceeded, etc.)
          if (res.statusCode !== 200) {
            console.error(`[words] OpenAI returned HTTP ${res.statusCode}:`, raw.slice(0, 300));
            return resolve(shuffle([...FALLBACK_WORDS]));
          }

          try {
            const json    = JSON.parse(raw);
            const content = json.choices?.[0]?.message?.content?.trim() ?? "";

            // Strip accidental markdown fences like ```json ... ```
            const clean = content.replace(/^```[a-z]*\s*/i, "").replace(/\s*```$/, "").trim();

            const words = JSON.parse(clean);

            if (Array.isArray(words) && words.length >= 10) {
              console.log(`[words] Generated ${words.length} words via OpenAI`);
              resolve(words.slice(0, 25));
            } else {
              throw new Error(`Expected array of ≥10, got: ${JSON.stringify(words).slice(0, 100)}`);
            }
          } catch (e) {
            console.error("[words] Parse error — using fallback:", e.message);
            resolve(shuffle([...FALLBACK_WORDS]));
          }
        });
      }
    );

    req.on("error", (e) => {
      console.error("[words] Request error — using fallback:", e.message);
      resolve(shuffle([...FALLBACK_WORDS]));
    });

    req.setTimeout(8000, () => {
      console.warn("[words] Timeout — using fallback");
      req.destroy();
      resolve(shuffle([...FALLBACK_WORDS]));
    });

    req.write(body);
    req.end();
  });
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
const rooms = new Map();

function getPublicRoom(room) {
  const revealPhase = room.phase === "results" || room.phase === "scoreboard";
  return {
    code:        room.code,
    hostId:      room.hostId,
    phase:       room.phase,
    players:     Array.from(room.players.values()),
    startPlayer: room.startPlayer,
    winner:      room.winner,
    winReason:   room.winReason,
    imposterId:  revealPhase ? room.imposterId : null,
    // Reveal the word to everyone once the round is over
    revealWord:  revealPhase ? room.word : null,
    roundNum:    room.roundNum,
    wordsLeft:   room.wordQueue.length,
  };
}

function broadcastRoom(io, room) {
  io.to(room.code).emit("room:update", getPublicRoom(room));
}

function nextWord(room) {
  if (room.wordQueue.length > 0) return room.wordQueue.shift();
  console.warn(`[room ${room.code}] Word queue empty — using fallback`);
  return FALLBACK_WORDS[Math.floor(Math.random() * FALLBACK_WORDS.length)];
}

function beginRound(io, room) {
  const ids        = Array.from(room.players.keys());
  room.word        = nextWord(room);
  room.imposterId  = ids[Math.floor(Math.random() * ids.length)];
  room.startPlayer = ids[Math.floor(Math.random() * ids.length)];
  room.phase       = "playing";
  room.winner      = null;
  room.winReason   = null;
  room.roundNum   += 1;

  for (const [sid] of room.players) {
    const isImposter = sid === room.imposterId;
    io.to(sid).emit("game:role", {
      isImposter,
      word:        isImposter ? null : room.word,
      startPlayer: room.startPlayer,
    });
  }

  broadcastRoom(io, room);
}

function scheduleWordGeneration(io, room) {
  generateWordList().then((words) => {
    room.wordQueue  = words;
    room.wordsReady = true;
    console.log(`[room ${room.code}] Word queue ready (${words.length} words)`);
    io.to(room.code).emit("room:wordsReady", { wordsLeft: words.length });
  });
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
  let currentRoom = null;

  socket.on("room:create", ({ name }, cb) => {
    if (!name?.trim()) return cb?.({ error: "Name required" });
    let code;
    do { code = genCode(); } while (rooms.has(code));

    const room = {
      code, hostId: socket.id,
      players:    new Map([[socket.id, { id: socket.id, name: name.trim(), score: 0 }]]),
      phase:      "lobby",
      word:       null, imposterId: null, startPlayer: null,
      winner:     null, winReason: null, roundNum: 0,
      wordQueue:  [],
      wordsReady: false,
    };

    rooms.set(code, room);
    currentRoom = code;
    socket.join(code);
    cb?.({ code });
    broadcastRoom(io, room);
    scheduleWordGeneration(io, room);
  });

  socket.on("room:join", ({ name, code }, cb) => {
    const normalized = String(code || "").toUpperCase().trim();
    const room = rooms.get(normalized);
    if (!name?.trim())           return cb?.({ error: "Name required" });
    if (!room)                   return cb?.({ error: "Room not found" });
    if (room.phase !== "lobby")  return cb?.({ error: "Game already started" });
    if (room.players.size >= 12) return cb?.({ error: "Room is full (max 12)" });
    room.players.set(socket.id, { id: socket.id, name: name.trim(), score: 0 });
    currentRoom = normalized;
    socket.join(normalized);
    cb?.({ code: normalized });
    broadcastRoom(io, room);
  });

  socket.on("room:sync", ({ code, name }, cb) => {
    const normalized = String(code || "").toUpperCase().trim();
    const room = rooms.get(normalized);
    if (!room) return cb?.({ error: "Room not found" });

    currentRoom = normalized;
    socket.join(normalized);

    if (room.players.has(socket.id)) {
      // Same socket ID — already in the room (tab still open, no migration needed)
    } else if (name) {
      // New socket ID after refresh/reconnect — find player by name and migrate
      const trimmed = name.trim();
      let existingEntry = null;
      for (const [pid, player] of room.players) {
        if (player.name === trimmed) { existingEntry = [pid, player]; break; }
      }
      if (existingEntry) {
        const [oldId, player] = existingEntry;
        room.players.delete(oldId);
        player.id = socket.id;
        room.players.set(socket.id, player);
        if (room.hostId      === oldId) room.hostId      = socket.id;
        if (room.imposterId  === oldId) room.imposterId  = socket.id;
        if (room.startPlayer === oldId) room.startPlayer = socket.id;
        broadcastRoom(io, room);
      } else if (room.phase === "lobby" && room.players.size < 12) {
        // Name not found, lobby still open — re-add as fresh player
        room.players.set(socket.id, { id: socket.id, name: trimmed, score: 0 });
        broadcastRoom(io, room);
      }
    }

    // Bug fix 1: re-emit game:role so the reconnecting player's role card shows correctly.
    // Without this, role stays null on the client and shows "Reconnecting…" forever.
    if (room.phase === "playing" || room.phase === "results") {
      const isImposter = room.imposterId === socket.id;
      socket.emit("game:role", {
        isImposter,
        word:        isImposter ? null : room.word,
        startPlayer: room.startPlayer,
      });
    }

    cb?.({ room: getPublicRoom(room) });
  });

  socket.on("game:start", (_, cb) => {
    const room = rooms.get(currentRoom);
    if (!room)                       return cb?.({ error: "Room not found" });
    if (room.hostId !== socket.id)   return cb?.({ error: "Only the host can start" });
    if (room.players.size < 2)       return cb?.({ error: "Need at least 2 players" });
    if (!room.wordsReady)            return cb?.({ error: "Words still generating, try again in a moment" });
    if (room.wordQueue.length === 0) return cb?.({ error: "No words left — reset the game to get a new set" });

    beginRound(io, room);
    cb?.({ ok: true });
  });

  socket.on("game:declare", ({ winner }, cb) => {
    const room = rooms.get(currentRoom);
    if (!room)                     return cb?.({ error: "Room not found" });
    if (room.hostId !== socket.id) return cb?.({ error: "Only the host can declare" });
    if (room.phase !== "playing")  return cb?.({ error: "Not in playing phase" });
    if (winner !== "players" && winner !== "imposter") return cb?.({ error: "Invalid winner" });

    room.winner = winner;
    if (winner === "players") {
      for (const [sid, player] of room.players) {
        if (sid !== room.imposterId) player.score += 1;
      }
      const imposterName = room.players.get(room.imposterId)?.name ?? "The imposter";
      room.winReason = `${imposterName} was the imposter! All players earn 1 point.`;
    } else {
      const imposter = room.players.get(room.imposterId);
      if (imposter) imposter.score += 3;
      room.winReason = `${room.players.get(room.imposterId)?.name ?? "The imposter"} fooled everyone and earns 3 points!`;
    }

    room.phase = "results";
    broadcastRoom(io, room);
    cb?.({ ok: true });
  });

  socket.on("game:nextRound", (_, cb) => {
    const room = rooms.get(currentRoom);
    if (!room)                       return cb?.({ error: "Room not found" });
    if (room.hostId !== socket.id)   return cb?.({ error: "Only host can advance" });
    if (room.wordQueue.length === 0) return cb?.({ error: "No words left — end the game to see scores" });

    beginRound(io, room);
    cb?.({ ok: true });
  });

  socket.on("game:end", (_, cb) => {
    const room = rooms.get(currentRoom);
    if (!room)                     return cb?.({ error: "Room not found" });
    if (room.hostId !== socket.id) return cb?.({ error: "Only host can end" });
    room.phase = "scoreboard";
    broadcastRoom(io, room);
    cb?.({ ok: true });
  });

  socket.on("game:reset", (_, cb) => {
    const room = rooms.get(currentRoom);
    if (!room)                     return cb?.({ error: "Room not found" });
    if (room.hostId !== socket.id) return cb?.({ error: "Only host can reset" });

    room.phase      = "lobby";
    room.word       = null; room.imposterId = null; room.startPlayer = null;
    room.winner     = null; room.winReason  = null; room.roundNum    = 0;
    room.wordQueue  = [];
    room.wordsReady = false;
    for (const player of room.players.values()) player.score = 0;

    broadcastRoom(io, room);
    cb?.({ ok: true });
    scheduleWordGeneration(io, room);
  });

  socket.on("disconnect", () => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;

    const disconnectedId   = socket.id;
    const disconnectedRoom = currentRoom;

    setTimeout(() => {
      const r = rooms.get(disconnectedRoom);
      if (!r) return; // room already gone
      if (!r.players.has(disconnectedId)) return; // already migrated to new socket
      // Player truly disconnected — clean up
      r.players.delete(disconnectedId);
      if (r.players.size === 0) { rooms.delete(disconnectedRoom); return; }
      if (r.hostId === disconnectedId) r.hostId = r.players.keys().next().value;
      broadcastRoom(io, r);
    }, 10000); // 10 second grace period
  });
});

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => console.log(`Socket.io server running on port ${PORT}`));