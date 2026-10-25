const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

// ---- Settings (tune these) ----
const W = 360, H = 640, R = 9;          // board size and ball radius
const GRAVITY = 0.2;                    // balls float UP toward FINISH
const BOUNCE = 0.4;                     // bounce factor on lines
const FINISH_Y = 40;                    // top strip is the finish line
const INK = 700;                        // drawing budget per player per round
const DRAW_MS = 20000;                  // drawing time before auto-start
const RACE_MS = 15000;                  // max race time
const WIN_ROUNDS = 3;                   // first to 3 rounds wins the match
const START = { red: { x: 90, y: H - 30 }, blue: { x: 270, y: H - 30 } };
const COLORS = ['red', 'blue'];

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const rooms = new Map();

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function makeCode() {
  let code;
  do {
    code = Math.random().toString(36).slice(2, 6).toUpperCase();
  } while (rooms.has(code));
  return code;
}

function publicState(room) {
  return {
    code: room.code,
    phase: room.phase,
    round: room.round,
    players: room.players.map((p) => ({ name: p.name, color: p.color })),
    scores: room.scores,
    ink: room.ink,
    ready: room.ready,
    deadline: room.deadline,
    winner: room.winner,
    winRounds: WIN_ROUNDS,
  };
}

function broadcast(room) {
  io.to(room.code).emit('state', publicState(room));
}

function newRound(room) {
  clearTimeout(room.timer);
  clearTimeout(room.raceTimer);
  clearInterval(room.tick);
  room.round++;
  room.lines = { red: [], blue: [] };
  room.ink = { red: INK, blue: INK };
  room.ready = { red: false, blue: false };
  room.balls = null;
  room.winner = null;
  room.phase = 'draw';
  room.deadline = Date.now() + DRAW_MS;
  room.timer = setTimeout(() => startRace(room), DRAW_MS);
  broadcast(room);
}

function startRace(room) {
  if (room.phase !== 'draw') return;
  clearTimeout(room.timer);
  room.phase = 'race';
  room.balls = {
    red: { x: START.red.x, y: START.red.y, vx: 0, vy: 0, done: false },
    blue: { x: START.blue.x, y: START.blue.y, vx: 0, vy: 0, done: false },
  };
  room.deadline = Date.now() + RACE_MS;
  broadcast(room);
  room.raceTimer = setTimeout(() => endRace(room, null), RACE_MS);
  room.tick = setInterval(() => tick(room), 1000 / 60);
}

function collide(b, s) {
  const dx = s.x2 - s.x1, dy = s.y2 - s.y1;
  const len2 = dx * dx + dy * dy || 1;
  const t = clamp(((b.x - s.x1) * dx + (b.y - s.y1) * dy) / len2, 0, 1);
  const px = s.x1 + dx * t, py = s.y1 + dy * t;
  let nx = b.x - px, ny = b.y - py;
  const d = Math.hypot(nx, ny);
  if (d >= R || d === 0) return;
  nx /= d; ny /= d;
  const push = R - d;
  b.x += nx * push;
  b.y += ny * push;
  const vn = b.vx * nx + b.vy * ny;
  if (vn < 0) {
    b.vx -= (1 + BOUNCE) * vn * nx;
    b.vy -= (1 + BOUNCE) * vn * ny;
  }
}

function tick(room) {
  const lines = [...room.lines.red, ...room.lines.blue];
  for (const c of COLORS) {
    const b = room.balls[c];
    if (b.done) continue;
    b.vy -= GRAVITY;               // gravity pulls UP
    b.x += b.vx;
    b.y += b.vy;
    if (b.x < R) { b.x = R; b.vx = Math.abs(b.vx) * BOUNCE; }
    if (b.x > W - R) { b.x = W - R; b.vx = -Math.abs(b.vx) * BOUNCE; }
    if (b.y > H - R) { b.y = H - R; b.vy = -Math.abs(b.vy) * BOUNCE; }
    for (const s of lines) collide(b, s);
    b.vx *= 0.995;
    if (b.y <= FINISH_Y) {
      b.done = true;
      endRace(room, c);
      return;
    }
  }
  io.to(room.code).emit('balls', room.balls);
}

function endRace(room, winner) {
  if (room.phase !== 'race') return;
  clearInterval(room.tick);
  clearTimeout(room.raceTimer);
  if (!winner) {
    // Time ran out: the ball higher on the board wins, ties give no point
    const r = room.balls.red, b = room.balls.blue;
    winner = r.y < b.y - 0.5 ? 'red' : b.y < r.y - 0.5 ? 'blue' : null;
  }
  room.winner = winner;
  if (winner) room.scores[winner]++;
  const over = room.scores.red >= WIN_ROUNDS || room.scores.blue >= WIN_ROUNDS;
  room.phase = over ? 'over' : 'roundEnd';
  broadcast(room);
  io.to(room.code).emit('balls', room.balls);
  if (!over) room.timer = setTimeout(() => newRound(room), 3000);
}

function join(socket, room, name, cb) {
  const taken = room.players.map((p) => p.color);
  const color = COLORS.find((c) => !taken.includes(c));
  room.players.push({ id: socket.id, name: String(name || 'لاعب').slice(0, 15), color });
  socket.data.roomCode = room.code;
  socket.data.color = color;
  socket.join(room.code);
  cb && cb({ ok: true, color, code: room.code });
  if (room.players.length === 2) newRound(room);
  else { room.phase = 'waiting'; broadcast(room); }
}

io.on('connection', (socket) => {
  socket.on('create', ({ name } = {}, cb) => {
    const code = makeCode();
    const room = {
      code, players: [], phase: 'waiting', round: 0,
      scores: { red: 0, blue: 0 }, ink: { red: INK, blue: INK },
      lines: { red: [], blue: [] }, ready: { red: false, blue: false },
      balls: null, winner: null, deadline: 0,
      timer: null, raceTimer: null, tick: null,
    };
    rooms.set(code, room);
    join(socket, room, name, cb);
  });

  socket.on('join', ({ code, name } = {}, cb) => {
    const room = rooms.get(String(code || '').toUpperCase().trim());
    if (!room) return cb && cb({ error: 'الكود ده مش موجود' });
    if (room.players.length >= 2) return cb && cb({ error: 'الأوضة مليانة' });
    join(socket, room, name, cb);
  });

  socket.on('seg', (s = {}) => {
    const room = rooms.get(socket.data.roomCode);
    const color = socket.data.color;
    if (!room || !color || room.phase !== 'draw') return;
    const x1 = clamp(+s.x1, 0, W), y1 = clamp(+s.y1, 0, H);
    const x2 = clamp(+s.x2, 0, W), y2 = clamp(+s.y2, 0, H);
    if ([x1, y1, x2, y2].some(Number.isNaN)) return;
    const cost = Math.hypot(x2 - x1, y2 - y1);
    if (cost < 0.5 || cost > room.ink[color]) return;
    room.ink[color] -= cost;
    const seg = { x1, y1, x2, y2 };
    room.lines[color].push(seg);
    io.to(room.code).emit('seg', { color, ...seg, ink: room.ink[color] });
  });

  socket.on('ready', () => {
    const room = rooms.get(socket.data.roomCode);
    const color = socket.data.color;
    if (!room || !color || room.phase !== 'draw') return;
    room.ready[color] = true;
    broadcast(room);
    if (room.ready.red && room.ready.blue) startRace(room);
  });

  socket.on('disconnect', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    room.players = room.players.filter((p) => p.id !== socket.id);
    clearTimeout(room.timer);
    clearTimeout(room.raceTimer);
    clearInterval(room.tick);
    if (room.players.length === 0) { rooms.delete(room.code); return; }
    room.phase = 'waiting';
    room.winner = null;
    broadcast(room);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Line Race running on http://localhost:${PORT}`));
