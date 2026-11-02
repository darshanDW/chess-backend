const http = require("http");
const path = require("path");
const express = require("express");
const { WebSocketServer, WebSocket } = require("ws");
const { Chess } = require("chess.js");

const PORT = Number(process.env.PORT || 3000);
const app = express();
app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (_req, res) => res.json({ ok: true, service: "chess-party" }));
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const rooms = new Map();
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const now = () => Date.now();
const uid = () => Math.random().toString(36).slice(2, 10);
const cleanName = s => String(s || "Player").trim().replace(/[<>]/g, "").slice(0, 18) || "Player";

function makeCode() {
  let code;
  do {
    code = Array.from({ length: 6 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join("");
  } while (rooms.has(code));
  return code;
}
function send(ws, type, data = {}) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type, ...data }));
}
function publicRoom(room) {
  return {
    code: room.code, hostId: room.hostId, phase: room.phase,
    durationMinutes: room.durationMinutes,
    players: [...room.players.values()].map(p => ({
      id: p.id, name: p.name, teamId: p.teamId, ready: p.ready, connected: p.connected
    })),
    teams: [...room.teams.values()].map(t => ({
      id: t.id, name: t.name, points: t.points, wins: t.wins, draws: t.draws,
      losses: t.losses, played: t.played
    })).sort((a,b) => b.points-a.points || b.wins-a.wins || a.name.localeCompare(b.name)),
    match: room.match ? {
      id: room.match.id, whiteId: room.match.whiteId, blackId: room.match.blackId,
      fen: room.match.game.fen(), pgn: room.match.game.pgn(),
      clocks: currentClocks(room.match), status: room.match.status,
      turn: room.match.game.turn(), lastMove: room.match.lastMove,
      result: room.match.result, startedAt: room.match.startedAt
    } : null,
    tournamentEndsAt: room.tournamentEndsAt,
    history: room.history.slice(-20)
  };
}
function broadcast(room) {
  const state = publicRoom(room);
  for (const p of room.players.values()) send(p.ws, "state", { room: state, you: p.id });
}
function teamPlayers(room, teamId) {
  return [...room.players.values()].filter(p => p.teamId === teamId);
}
function teamEligible(room, teamId) {
  const ps = teamPlayers(room, teamId);
  const required = room.mode === "practice" ? 1 : 2;
  return ps.length === required && ps.every(p => p.connected);
}
function currentClocks(match) {
  const c = { ...match.clocks };
  if (match.status === "active" && match.runningSince) {
    const elapsed = Math.max(0, now() - match.runningSince);
    c[match.game.turn()] = Math.max(0, c[match.game.turn()] - elapsed);
  }
  return { white: Math.max(0, Math.floor(c.w)), black: Math.max(0, Math.floor(c.b)) };
}
function stopClock(match) {
  if (!match || match.status !== "active" || !match.runningSince) return;
  const elapsed = now() - match.runningSince;
  match.clocks[match.game.turn()] = Math.max(0, match.clocks[match.game.turn()] - elapsed);
  match.runningSince = null;
}
function startClock(match) {
  if (match && match.status === "active") match.runningSince = now();
}
function chooseNextTeam(room, excludeTeamId = null) {
  const candidates = [...room.teams.values()]
    .filter(t => t.id !== excludeTeamId && teamEligible(room, t.id))
    .sort((a,b) => b.points-a.points || b.wins-a.wins || a.lastPlayedAt-b.lastPlayedAt);
  return candidates[0] || null;
}
function nextPlayer(room, teamId) {
  const players = teamPlayers(room, teamId);
  if (!players.length) return null;
  const last = room.lastPlayerByTeam[teamId];
  const sorted = players.slice().sort((a,b) => {
    const ar = a.id === last ? 1 : 0, br = b.id === last ? 1 : 0;
    return ar-br || a.name.localeCompare(b.name);
  });
  const chosen = sorted[0];
  room.lastPlayerByTeam[teamId] = chosen.id;
  return chosen;
}
function beginMatch(room, whiteTeam, blackTeam) {
  const white = nextPlayer(room, whiteTeam.id);
  const black = nextPlayer(room, blackTeam.id);
  if (!white || !black) return false;
  const game = new Chess();
  const match = {
    id: uid(), game, whiteId: white.id, blackId: black.id,
    whiteTeamId: whiteTeam.id, blackTeamId: blackTeam.id,
    clocks: { w: 180000, b: 180000 }, runningSince: null,
    status: "active", startedAt: now(), lastMove: null, result: null
  };
  room.match = match;
  startClock(match);
  room.phase = "playing";
  room.activeTeamId = whiteTeam.id;
  return true;
}
function startNextMatch(room) {
  if (room.phase === "finished" || room.phase === "playing") return;
  const readyTeams = [...room.teams.values()].filter(t => teamEligible(room, t.id));
  if (readyTeams.length < 2) {
    room.phase = "lobby";
    return;
  }
  const winnerTeamId = room.previousWinnerTeamId;
  let first = null, second = null;
  if (winnerTeamId && teamEligible(room, winnerTeamId)) {
    first = room.teams.get(winnerTeamId);
    second = chooseNextTeam(room, winnerTeamId);
  } else {
    first = chooseNextTeam(room);
    second = first && chooseNextTeam(room, first.id);
  }
  if (first && second) beginMatch(room, first, second);
  else room.phase = "lobby";
}
function finishMatch(room, winnerTeamId, reason) {
  const m = room.match;
  if (!m || m.status !== "active") return;
  stopClock(m);
  m.status = "finished";
  const whiteTeam = room.teams.get(m.whiteTeamId);
  const blackTeam = room.teams.get(m.blackTeamId);
  whiteTeam.played++; blackTeam.played++;
  if (winnerTeamId === m.whiteTeamId || winnerTeamId === m.blackTeamId) {
    const winner = room.teams.get(winnerTeamId);
    const loser = room.teams.get(winnerTeamId === m.whiteTeamId ? m.blackTeamId : m.whiteTeamId);
    winner.points += 3; winner.wins++; loser.losses++;
    winner.lastPlayedAt = now();
    room.previousWinnerTeamId = winnerTeamId;
    m.result = { winnerTeamId, text: `${winner.name} wins`, reason };
  } else {
    whiteTeam.points++; blackTeam.points++;
    whiteTeam.draws++; blackTeam.draws++;
    room.previousWinnerTeamId = null;
    m.result = { winnerTeamId: null, text: "Draw", reason };
  }
  room.history.push({
    id: m.id, whiteTeam: whiteTeam.name, blackTeam: blackTeam.name,
    whitePlayer: room.players.get(m.whiteId)?.name || "Player",
    blackPlayer: room.players.get(m.blackId)?.name || "Player",
    result: m.result.text, reason, at: now()
  });
  room.phase = "between";
  broadcast(room);
  setTimeout(() => {
    if (rooms.has(room.code) && room.match === m && room.phase === "between") {
      room.match = null;
      if (room.tournamentEndsAt && now() >= room.tournamentEndsAt) room.phase = "finished";
      else startNextMatch(room);
      broadcast(room);
    }
  }, 3500);
}
function claimTimeout(room) {
  const m = room.match;
  if (!m || m.status !== "active") return;
  const clocks = currentClocks(m);
  const side = m.game.turn();
  if (clocks[side === "w" ? "white" : "black"] > 0) return;
  const loserId = side === "w" ? m.whiteId : m.blackId;
  const winnerId = side === "w" ? m.blackId : m.whiteId;
  const winnerTeamId = side === "w" ? m.blackTeamId : m.whiteTeamId;
  // chess.js handles the insufficient-material timeout exception.
  const winnerColor = side === "w" ? "b" : "w";
  const canMate = m.game.isCheckmate() || !m.game.isInsufficientMaterial();
  finishMatch(room, canMate ? winnerTeamId : null, "timeout");
}
function tick() {
  for (const room of rooms.values()) {
    if (room.match?.status === "active") {
      const c = currentClocks(room.match);
      if (c.white <= 0 || c.black <= 0) claimTimeout(room);
      else broadcast(room);
    }
    if (room.phase !== "finished" && room.tournamentEndsAt && now() >= room.tournamentEndsAt && !room.match) {
      room.phase = "finished";
      broadcast(room);
    }
  }
}
setInterval(tick, 500);

function handle(ws, msg) {
  const data = msg || {};
  if (data.type === "create") {
    const name = cleanName(data.name);
    const code = makeCode();
    const playerId = uid(), teamId = uid();
    const room = {
      code, hostId: playerId, phase: "lobby", durationMinutes: [10,15].includes(Number(data.durationMinutes)) ? Number(data.durationMinutes) : 15,
      mode: "teams",
      players: new Map(), teams: new Map(), match: null, history: [],
      previousWinnerTeamId: null, activeTeamId: null, lastPlayerByTeam: {},
      tournamentEndsAt: null
    };
    room.teams.set(teamId, { id: teamId, name: cleanName(data.teamName || "Team 1"), points: 0, wins: 0, draws: 0, losses: 0, played: 0, lastPlayedAt: 0 });
    const token = uid() + uid();
    room.players.set(playerId, { id: playerId, token, name, teamId, ready: true, connected: true, ws });
    ws.playerId = playerId; ws.roomCode = code;
    rooms.set(code, room);
    send(ws, "joined", { room: publicRoom(room), you: playerId, token });
    broadcast(room);
    return;
  }
  if (data.type === "join") {
    const code = String(data.code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    const room = rooms.get(code);
    if (!room) return send(ws, "error", { message: "Room not found. Check the code and try again." });
    if (room.phase !== "lobby") return send(ws, "error", { message: "This room has already started." });
    if (room.players.size >= 8) return send(ws, "error", { message: "This room is full (8 players maximum)." });
    const playerId = uid(), name = cleanName(data.name);
    const teamId = String(data.teamId || "");
    let team = room.teams.get(teamId);
    if (!team || teamPlayers(room, teamId).length >= 2) {
      team = [...room.teams.values()].find(t => teamPlayers(room, t.id).length < 2);
      if (!team) {
        const id = uid();
        team = { id, name: `Team ${room.teams.size + 1}`, points: 0, wins: 0, draws: 0, losses: 0, played: 0, lastPlayedAt: 0 };
        room.teams.set(id, team);
      }
    }
    const token = uid() + uid();
    room.players.set(playerId, { id: playerId, token, name, teamId: team.id, ready: false, connected: true, ws });
    ws.playerId = playerId; ws.roomCode = code;
    send(ws, "joined", { room: publicRoom(room), you: playerId, token });
    broadcast(room);
    return;
  }
  if (data.type === "resume") {
    const code = String(data.code || "").toUpperCase();
    const room = rooms.get(code);
    const player = room && [...room.players.values()].find(p => p.token === data.token);
    if (!player) return send(ws, "error", { message: "Your previous session could not be restored. Rejoin with the room code." });
    player.connected = true; player.ws = ws;
    ws.playerId = player.id; ws.roomCode = code;
    send(ws, "joined", { room: publicRoom(room), you: player.id, token: player.token });
    broadcast(room);
    return;
  }
  const room = rooms.get(ws.roomCode);
  const player = room && room.players.get(ws.playerId);
  if (!room || !player) return send(ws, "error", { message: "Join a room first." });
  if (data.type === "ready") {
    player.ready = !!data.ready;
    broadcast(room);
  } else if (data.type === "rename-team") {
    if (room.phase !== "lobby") return;
    const team = room.teams.get(player.teamId);
    if (team) team.name = cleanName(data.name).slice(0, 18);
    broadcast(room);
  } else if (data.type === "start") {
    if (player.id !== room.hostId) return send(ws, "error", { message: "Only the host can start the tournament." });
    if (![2,4,6,8].includes(room.players.size)) return send(ws, "error", { message: "Start with 2, 4, 6, or 8 players." });
    if ([...room.players.values()].some(p => !p.ready || !p.connected)) return send(ws, "error", { message: "Everyone must be connected and ready." });
    if (room.players.size === 2) {
      room.mode = "practice";
      room.teams.clear();
      for (const p of room.players.values()) {
        const id = uid(); p.teamId = id;
        room.teams.set(id, { id, name: p.name, points: 0, wins: 0, draws: 0, losses: 0, played: 0, lastPlayedAt: 0 });
      }
    } else {
      room.mode = "teams";
      if ([...room.teams.values()].some(t => teamPlayers(room, t.id).length !== 2)) return send(ws, "error", { message: "Each team must have exactly two players." });
    }
    room.tournamentEndsAt = now() + room.durationMinutes * 60000;
    room.phase = "between";
    startNextMatch(room);
    broadcast(room);
  } else if (data.type === "move") {
    const m = room.match;
    if (!m || m.status !== "active") return;
    const color = player.id === m.whiteId ? "w" : player.id === m.blackId ? "b" : null;
    if (!color || color !== m.game.turn()) return send(ws, "error", { message: "It's not your turn in this match." });
    const clocks = currentClocks(m);
    if (clocks[color === "w" ? "white" : "black"] <= 0) return claimTimeout(room);
    let move;
    try {
      move = m.game.move({ from: data.from, to: data.to, promotion: data.promotion || "q" });
    } catch (_) {
      return send(ws, "error", { message: "Illegal chess move." });
    }
    stopClock(m);
    m.clocks[color] += 2000;
    m.lastMove = { from: move.from, to: move.to, san: move.san };
    if (m.game.isCheckmate()) {
      finishMatch(room, color === "w" ? m.whiteTeamId : m.blackTeamId, "checkmate");
      return;
    }
    if (m.game.isDraw()) {
      finishMatch(room, null, m.game.isStalemate() ? "stalemate" : "draw");
      return;
    }
    startClock(m);
    broadcast(room);
  } else if (data.type === "resign") {
    const m = room.match;
    if (!m || m.status !== "active" || (player.id !== m.whiteId && player.id !== m.blackId)) return;
    finishMatch(room, player.id === m.whiteId ? m.blackTeamId : m.whiteTeamId, "resignation");
  } else if (data.type === "end-tournament") {
    if (player.id !== room.hostId) return;
    room.tournamentEndsAt = now();
    if (room.match?.status === "active") finishMatch(room, null, "tournament-ended");
    room.phase = "finished";
    broadcast(room);
  }
}
wss.on("connection", ws => {
  ws.on("message", raw => {
    try { handle(ws, JSON.parse(raw.toString())); }
    catch (e) { send(ws, "error", { message: "Something went wrong. Please try again." }); }
  });
  ws.on("close", () => {
    const room = rooms.get(ws.roomCode);
    const p = room && room.players.get(ws.playerId);
    if (p && p.ws === ws) {
      p.connected = false;
      if (room.hostId === p.id) {
        const next = [...room.players.values()].find(x => x.connected);
        if (next) room.hostId = next.id;
      }
      broadcast(room);
    }
  });
});

server.listen(PORT, () => console.log(`Chess Party running at http://localhost:${PORT}`));
