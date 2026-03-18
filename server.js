const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const server = http.createServer((req, res) => {
  let filePath = path.join(__dirname, 'public', req.url === '/' ? 'index.html' : req.url);
  const ext = path.extname(filePath);
  const contentTypes = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' };
  const contentType = contentTypes[ext] || 'text/plain';
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

const wss = new WebSocket.Server({ server });
const rooms = new Map();

function generateCode() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

const ROLES = {
  CRITIC: 'critic',
  AVOCAT: 'avocat',
  DOCTOR: 'doctor',
  FISC: 'fisc',
  DON: 'don',
  SEBASTIAN: 'sebastian',
  MAFIOT: 'mafiot',
  BOSCHETAR: 'boschetar',
  EXECUTOR: 'executor',
  LOCUITOR: 'locuitor',
};

// Night sequence - no timers, each advances when action done
// Executor is parallel (anytime during night)
// Night ends when boschetar finishes
const NIGHT_SEQUENCE = ['doctor', 'fisc', 'critic', 'mafia', 'boschetar'];

const MAFIA_ROLES = [ROLES.DON, ROLES.SEBASTIAN, ROLES.MAFIOT];
function isMafia(role) { return MAFIA_ROLES.includes(role); }

function createRoom(code) {
  return {
    code,
    players: new Map(),
    phase: 'lobby',
    moderatorId: null,
    dayNumber: 0,
    votes: new Map(),
    advocateId: null,
    advocateRatings: new Map(),
    advocateBlocked: new Map(),
    judgeVotes: new Map(),
    defendingPlayerId: null,
    nightPhase: null,
    nightActions: new Map(),
    criticQuestion: null,
    criticAnswered: false,
    executorRequest: null,
    executorAccepted: false,
    dayLog: [],
    fiscTargetId: null,
    mutedThisDay: new Set(),
    criticColors: new Map(),
    boschetarVisit: null,
    nightDone: new Set(), // tracks who finished their night action
  };
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function assignRoles(n) {
  const roles = [];
  const mafiaTotal = Math.floor((n - 2) / 3);
  roles.push(ROLES.DON);
  roles.push(ROLES.SEBASTIAN);
  for (let i = 2; i < mafiaTotal; i++) roles.push(ROLES.MAFIOT);
  roles.push(ROLES.CRITIC);
  roles.push(ROLES.AVOCAT);
  roles.push(ROLES.AVOCAT);
  roles.push(ROLES.DOCTOR);
  roles.push(ROLES.FISC);
  roles.push(ROLES.BOSCHETAR);
  roles.push(ROLES.EXECUTOR);
  while (roles.length < n) roles.push(ROLES.LOCUITOR);
  while (roles.length > n) {
    const idx = roles.lastIndexOf(ROLES.LOCUITOR);
    if (idx !== -1) roles.splice(idx, 1);
    else roles.pop();
  }
  return shuffle(roles);
}

function broadcast(room, message, excludeId = null) {
  room.players.forEach((player, id) => {
    if (id !== excludeId && player.ws && player.ws.readyState === WebSocket.OPEN) {
      player.ws.send(JSON.stringify(message));
    }
  });
}

function sendTo(player, message) {
  if (player && player.ws && player.ws.readyState === WebSocket.OPEN) {
    player.ws.send(JSON.stringify(message));
  }
}

function sendToId(room, playerId, message) {
  const p = room.players.get(playerId);
  if (p) sendTo(p, message);
}

function getPublicPlayers(room) {
  // BUG FIX 2: Do NOT expose roles publicly - roles are private
  return Array.from(room.players.values()).map(p => ({
    id: p.id,
    name: p.name,
    alive: p.alive,
    isModerator: p.id === room.moderatorId,
    muted: room.mutedThisDay && room.mutedThisDay.has(p.id),
    // role is NOT included here - sent privately to each player and moderator only
  }));
}

function getModeratorPlayers(room) {
  // Full player info for moderator only
  return Array.from(room.players.values()).map(p => ({
    id: p.id,
    name: p.name,
    alive: p.alive,
    isModerator: p.id === room.moderatorId,
    muted: room.mutedThisDay && room.mutedThisDay.has(p.id),
    role: p.role,
  }));
}

function getMafiaTeam(room) {
  return Array.from(room.players.values())
    .filter(p => isMafia(p.role))
    .map(p => ({ id: p.id, name: p.name, role: p.role }));
}

function checkWin(room) {
  const alive = Array.from(room.players.values()).filter(p => p.alive && p.id !== room.moderatorId);
  const aliveMafia = alive.filter(p => isMafia(p.role));
  const aliveGood = alive.filter(p => !isMafia(p.role) && p.role !== ROLES.AVOCAT);
  if (aliveMafia.length === 0) return 'citizens';
  if (aliveMafia.length >= aliveGood.length) return 'mafia';
  return null;
}

function endGame(room, winner) {
  room.phase = 'ended';
  const allPlayers = Array.from(room.players.values()).map(p => ({
    id: p.id, name: p.name, role: p.role, alive: p.alive,
    advocateRating: room.advocateRatings.get(p.id) || 0,
  }));
  let bestAdvocate = null, bestRating = -1;
  allPlayers.forEach(p => {
    if (p.role === ROLES.AVOCAT && p.advocateRating > bestRating) {
      bestRating = p.advocateRating; bestAdvocate = p;
    }
  });
  broadcast(room, { type: 'game_ended', winner, players: allPlayers, bestAdvocate });
}

// ===== NIGHT - ALL PARALLEL, ends when boschetar finishes =====
function startNight(room) {
  room.phase = 'night';
  room.nightPhase = 'active';
  room.nightActions.clear();
  room.nightDone = new Set();
  room.criticQuestion = null;
  room.criticAnswered = false;
  room.executorRequest = null;
  room.executorAccepted = false;
  room.boschetarVisit = null;
  room.fiscTargetId = null;

  // Send public list to all players, full list to moderator
  broadcast(room, { type: 'night_started', dayNumber: room.dayNumber, players: getPublicPlayers(room) });
  const modPlayer = room.players.get(room.moderatorId);
  if (modPlayer) sendTo(modPlayer, { type: 'moderator_players_update', players: getModeratorPlayers(room) });

  // Notify each player of their night role - all at once (PARALLEL)
  room.players.forEach(p => {
    if (!p.alive || p.id === room.moderatorId) return;
    sendTo(p, { type: 'night_phase', phase: 'active', active: true, role: p.role });
  });
}

// Called after boschetar acts OR moderator forces day
function advanceNight(room) {
  resolveNight(room);
}

function isActiveInPhase(role, phase) {
  // Kept for compatibility
  return true;
}

function processCriticAnswer(room, playerId, answer) {
  if (!room.criticQuestion) return;
  room.criticAnswered = true;
  const correct = answer === room.criticQuestion.correctAnswer;
  let finalResult = correct;

  // Fisc overrides to wrong
  if (room.fiscTargetId === playerId) finalResult = false;
  // Doctor protection -> correct
  if (room.nightActions.get('doctor_saved') === playerId) finalResult = true;

  const criticPlayer = Array.from(room.players.values()).find(p => p.role === ROLES.CRITIC);
  if (criticPlayer) {
    if (!room.criticColors.has(criticPlayer.id)) room.criticColors.set(criticPlayer.id, new Map());
    room.criticColors.get(criticPlayer.id).set(playerId, finalResult ? 'green' : 'red');
    sendTo(criticPlayer, { type: 'critic_color_update', targetId: playerId, color: finalResult ? 'green' : 'red' });
  }
}

function resolveNight(room) {
  const actions = room.nightActions;
  const killedThisNight = new Set();

  const doctorSavedId = actions.get('doctor_saved');
  const fiscTargetId = room.fiscTargetId;
  if (fiscTargetId) room.mutedThisDay.add(fiscTargetId);

  // Mafia kill vote
  const killVotes = new Map();
  actions.forEach((val, key) => {
    if (key.startsWith('mafia_kill_')) killVotes.set(val, (killVotes.get(val) || 0) + 1);
  });
  let mafiaKillTarget = null, maxKV = 0;
  killVotes.forEach((v, tid) => { if (v > maxKV) { maxKV = v; mafiaKillTarget = tid; } });

  const don = Array.from(room.players.values()).find(p => p.role === ROLES.DON && p.alive);

  // Boschetar
  if (room.boschetarVisit) {
    const { vagrantId, visitedId } = room.boschetarVisit;
    let visitorFound = null;
    if (mafiaKillTarget === visitedId) {
      visitorFound = don || { name: 'Mafia', role: 'mafiot' };
    }
    const vagrant = room.players.get(vagrantId);
    if (vagrant) {
      const sawVisitor = !!visitorFound;
      sendTo(vagrant, {
        type: 'boschetar_result',
        sawVisitor,
        visitorName: sawVisitor ? visitorFound.name : null,
        visitorRole: sawVisitor ? visitorFound.role : null,
      });
      room.boschetarVisit.sawVisitor = sawVisitor;
    }
  }

  // Executor kill (if accepted before boschetar finished)
  let executorKilled = null;
  if (room.executorRequest && room.executorAccepted) {
    const { targetId } = room.executorRequest;
    const target = room.players.get(targetId);
    if (target && target.alive && targetId !== doctorSavedId && target.role !== ROLES.AVOCAT) {
      target.alive = false;
      killedThisNight.add(targetId);
      executorKilled = { id: target.id, name: target.name, role: target.role };
    }
  }

  // Mafia kill - avocatii nu pot fi ucisi
  let mafiaKilled = null;
  if (mafiaKillTarget && mafiaKillTarget !== doctorSavedId && !killedThisNight.has(mafiaKillTarget)) {
    const target = room.players.get(mafiaKillTarget);
    if (target && target.alive && target.role !== ROLES.AVOCAT) {
      target.alive = false;
      killedThisNight.add(mafiaKillTarget);
      mafiaKilled = { id: target.id, name: target.name, role: target.role };
    }
  }

  // Build day log
  room.dayLog = [];
  const critic = Array.from(room.players.values()).find(p => p.role === ROLES.CRITIC && p.alive);
  const doctor = Array.from(room.players.values()).find(p => p.role === ROLES.DOCTOR && p.alive);
  const fisc = Array.from(room.players.values()).find(p => p.role === ROLES.FISC && p.alive);
  const boschetar = Array.from(room.players.values()).find(p => p.role === ROLES.BOSCHETAR && p.alive);
  const executorP = Array.from(room.players.values()).find(p => p.role === ROLES.EXECUTOR && p.alive);

  if (doctor && actions.get('doctor_saved')) room.dayLog.push('Doctorul Lingvist-Literar a salvat pe cineva în această noapte.');
  if (fisc && fiscTargetId) room.dayLog.push('Fiscul Lingvist-Literar și-a făcut datoria în această noapte.');
  if (critic && room.criticQuestion) room.dayLog.push('Criticul Lingvist-Literar a depus întrebarea.');
  room.dayLog.push('Mafia Literară a acționat în umbră.');
  if (boschetar) {
    room.dayLog.push(room.boschetarVisit?.sawVisitor
      ? 'Boschetarul Lingvist-Literar a venit cu gânduri grele acasă.'
      : 'Boschetarul Lingvist-Literar a venit cu o carte acasă.');
  }
  if (executorP && room.executorRequest) room.dayLog.push('Executorul Lingvist-Literar a trimis o cerere în această noapte.');
  if (mafiaKilled) room.dayLog.push(`${mafiaKilled.name} a fost eliminat în această noapte.`);
  else if (!executorKilled) room.dayLog.push('Orașul a dormit liniștit.');
  if (executorKilled) room.dayLog.push(`${executorKilled.name} a fost executat în această noapte.`);

  room.phase = 'day';
  room.dayNumber++;
  room.votes.clear();
  room.judgeVotes.clear();
  room.advocateId = null;
  room.defendingPlayerId = null;

  room.advocateBlocked.forEach((rounds, id) => {
    if (rounds > 0) room.advocateBlocked.set(id, rounds - 1);
  });

  const winner = checkWin(room);
  if (winner) { endGame(room, winner); return; }

  const pubPlayers = getPublicPlayers(room);
  const modPlayersData = getModeratorPlayers(room);
  // Send moderator their special full list
  const modRef = room.players.get(room.moderatorId);
  if (modRef) sendTo(modRef, { type: 'moderator_players_update', players: modPlayersData });

  broadcast(room, {
    type: 'day_started',
    dayNumber: room.dayNumber,
    players: pubPlayers,
    dayLog: room.dayLog,
    mafiaKilled,
    executorKilled,
    mutedPlayers: Array.from(room.mutedThisDay),
    criticColors: Object.fromEntries(
      Array.from(room.criticColors.entries()).map(([k, v]) => [k, Object.fromEntries(v)])
    ),
  });
}

function resolveFirstVote(room) {
  const voteCounts = new Map();
  room.votes.forEach((targetId, voterId) => {
    const voter = room.players.get(voterId);
    if (!voter || room.mutedThisDay.has(voterId) || voter.role === ROLES.AVOCAT) return;
    if (targetId) voteCounts.set(targetId, (voteCounts.get(targetId) || 0) + 1);
  });

  let topPlayer = null, maxV = 0, tied = false;
  voteCounts.forEach((count, targetId) => {
    if (count > maxV) { maxV = count; topPlayer = targetId; tied = false; }
    else if (count === maxV) tied = true;
  });
  if (tied) topPlayer = null;

  if (!topPlayer) {
    broadcast(room, { type: 'vote_tied', players: getPublicPlayers(room) });
    room.votes.clear();
    return;
  }

  room.defendingPlayerId = topPlayer;
  room.votes.clear();

  broadcast(room, {
    type: 'judge_phase',
    defendingPlayerId: topPlayer,
    defendingPlayerName: room.players.get(topPlayer)?.name,
    players: getPublicPlayers(room),
  });
}

function resolveJudgeVote(room) {
  let likes = 0, dislikes = 0;
  room.judgeVotes.forEach((vote, voterId) => {
    const voter = room.players.get(voterId);
    if (!voter) return;
    let weight = 1;
    if (voter.role === ROLES.CRITIC) weight = 4;
    if (voterId === room.moderatorId) weight = 3;
    if (vote === 'like') likes += weight;
    else dislikes += weight;
  });

  const total = likes + dislikes;
  const eliminated = likes > dislikes;

  if (room.advocateId) {
    const ratio = total > 0 ? dislikes / total : 0;
    const points = ratio * 10;
    const current = room.advocateRatings.get(room.advocateId) || 0;
    room.advocateRatings.set(room.advocateId, +(current + points).toFixed(2));
    if (ratio < 0.1) room.advocateBlocked.set(room.advocateId, 2);
    else if (ratio < 0.4) room.advocateBlocked.set(room.advocateId, 1);
  }

  if (eliminated && room.defendingPlayerId) {
    const player = room.players.get(room.defendingPlayerId);
    if (player) {
      player.alive = false;
      broadcast(room, {
        type: 'player_eliminated',
        playerId: player.id, playerName: player.name, role: player.role,
        likes, dislikes, players: getPublicPlayers(room),
      });
    }
  } else {
    broadcast(room, { type: 'player_spared', likes, dislikes, players: getPublicPlayers(room) });
  }

  room.judgeVotes.clear();
  room.defendingPlayerId = null;
  room.mutedThisDay.clear();

  const winner = checkWin(room);
  if (winner) { endGame(room, winner); return; }
}

// ===== WEBSOCKET =====
wss.on('connection', (ws) => {
  let playerId = null;
  let roomCode = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case 'create_room': {
        const code = generateCode();
        const room = createRoom(code);
        rooms.set(code, room);
        roomCode = code;
        playerId = msg.playerId || require('crypto').randomUUID();
        const player = { id: playerId, name: msg.name, role: null, alive: true, ws };
        room.players.set(playerId, player);
        room.moderatorId = playerId;
        sendTo(player, { type: 'room_created', code, playerId, players: getPublicPlayers(room) });
        break;
      }

      case 'join_room': {
        const room = rooms.get(msg.code);
        if (!room) { ws.send(JSON.stringify({ type: 'error', message: 'camera_negasita' })); return; }
        if (room.phase !== 'lobby') { ws.send(JSON.stringify({ type: 'error', message: 'joc_inceput' })); return; }
        if (room.players.size >= 31) { ws.send(JSON.stringify({ type: 'error', message: 'camera_plina' })); return; }
        roomCode = msg.code;

        // Reconnect by playerId
        if (msg.playerId && room.players.has(msg.playerId)) {
          playerId = msg.playerId;
          const existing = room.players.get(playerId);
          existing.ws = ws;
          sendTo(existing, { type: 'room_rejoined', code: roomCode, playerId, players: getPublicPlayers(room) });
          broadcast(room, { type: 'player_joined', players: getPublicPlayers(room) }, playerId);
          return;
        }

        // Reconnect by name (ghost fix)
        const existingByName = Array.from(room.players.values()).find(p => p.name === msg.name && !p.ws);
        if (existingByName) {
          playerId = existingByName.id;
          existingByName.ws = ws;
          sendTo(existingByName, { type: 'room_rejoined', code: roomCode, playerId, players: getPublicPlayers(room) });
          broadcast(room, { type: 'player_joined', players: getPublicPlayers(room) }, playerId);
          return;
        }

        playerId = msg.playerId || require('crypto').randomUUID();
        let finalName = msg.name;
        const names = Array.from(room.players.values()).map(p => p.name);
        let suffix = 2;
        while (names.includes(finalName)) { finalName = msg.name + suffix; suffix++; }

        const player = { id: playerId, name: finalName, role: null, alive: true, ws };
        room.players.set(playerId, player);
        sendTo(player, { type: 'room_joined', code: roomCode, playerId, name: finalName, players: getPublicPlayers(room) });
        broadcast(room, { type: 'player_joined', players: getPublicPlayers(room) }, playerId);
        break;
      }

      case 'start_game': {
        const room = rooms.get(roomCode);
        if (!room || msg.playerId !== room.moderatorId) return;
        const gamePlayers = Array.from(room.players.values()).filter(p => p.id !== room.moderatorId);
        if (gamePlayers.length < 13) {
          sendToId(room, room.moderatorId, { type: 'error', message: 'jucatori_insuficienti' });
          return;
        }
        const roles = assignRoles(gamePlayers.length);
        gamePlayers.forEach((player, i) => { player.role = roles[i]; player.alive = true; });
        room.phase = 'night';
        room.dayNumber = 1;

        gamePlayers.forEach(player => {
          const mafiaTeam = isMafia(player.role) ? getMafiaTeam(room) : null;
          sendTo(player, { type: 'game_started', role: player.role, mafiaTeam, players: getPublicPlayers(room) });
          // Resend after 600ms to fix citizens stuck in lobby
          setTimeout(() => {
            if (player.ws && player.ws.readyState === WebSocket.OPEN)
              sendTo(player, { type: 'game_started', role: player.role, mafiaTeam, players: getPublicPlayers(room) });
          }, 600);
        });
        sendToId(room, room.moderatorId, { type: 'game_started', role: 'moderator', players: getModeratorPlayers(room) });

        // Start night after 11s (10s role reveal + 1s buffer)
        setTimeout(() => startNight(room), 11000);
        break;
      }

      case 'night_action': {
        const room = rooms.get(roomCode);
        if (!room || room.phase !== 'night') return;
        const player = room.players.get(playerId);
        if (!player || !player.alive) return;

        switch (msg.action) {
          case 'doctor_save':
            if (player.role === ROLES.DOCTOR && room.phase === 'night' && !room.nightDone.has(playerId)) {
              room.nightActions.set('doctor_saved', msg.targetId);
              room.nightDone.add(playerId);
              sendTo(player, { type: 'night_action_confirmed' });
            }
            break;

          case 'fisc_mute':
            if (player.role === ROLES.FISC && room.phase === 'night' && !room.nightDone.has(playerId)) {
              room.fiscTargetId = msg.targetId;
              room.nightDone.add(playerId);
              sendTo(player, { type: 'night_action_confirmed' });
            }
            break;

          case 'critic_send_question':
            if (player.role === ROLES.CRITIC && room.phase === 'night' && !room.nightDone.has(playerId)) {
              room.criticQuestion = {
                question: msg.question,
                correctAnswer: msg.correctAnswer,
                targetId: msg.targetId,
                askedBy: playerId,
              };
              room.nightDone.add(playerId);
              sendTo(player, { type: 'night_action_confirmed' });
              // Send question to target
              const target = room.players.get(msg.targetId);
              if (target) sendTo(target, { type: 'critic_question', question: msg.question });
            }
            break;

          case 'critic_answer':
            if (room.criticQuestion && msg.targetId === room.criticQuestion.targetId && !room.criticAnswered) {
              processCriticAnswer(room, playerId, msg.answer);
              sendTo(player, { type: 'night_action_confirmed' });
            }
            break;

          case 'mafia_kill':
            if (isMafia(player.role) && room.phase === 'night') {
              // Avocatii nu pot fi tinta mafiei
              const killTarget = room.players.get(msg.targetId);
              if (killTarget && killTarget.role === ROLES.AVOCAT) {
                sendTo(player, { type: 'error', message: 'tinta_invalida' });
                return;
              }
              room.nightActions.set(`mafia_kill_${playerId}`, msg.targetId);
              room.nightDone.add(playerId);
              sendTo(player, { type: 'night_action_confirmed' });
            }
            break;

          case 'boschetar_visit':
            if (player.role === ROLES.BOSCHETAR && room.phase === 'night' && !room.nightDone.has(playerId)) {
              room.boschetarVisit = { vagrantId: playerId, visitedId: msg.targetId, sawVisitor: false };
              room.nightActions.set(`visit_${playerId}`, msg.targetId);
              room.nightDone.add(playerId);
              sendTo(player, { type: 'night_action_confirmed' });
              // Boschetarul ends the night
              resolveNight(room);
            }
            break;

          case 'executor_write':
            // Executor can write at ANY point during the night
            if (player.role === ROLES.EXECUTOR && !room.executorRequest) {
              const execTarget = room.players.get(msg.targetId);
              if (execTarget && execTarget.role === ROLES.AVOCAT) return; // can't target avocat
              room.executorRequest = { targetId: msg.targetId, message: msg.message, requesterId: playerId };
              const criticP = Array.from(room.players.values()).find(p => p.role === ROLES.CRITIC && p.alive);
              const modP = room.players.get(room.moderatorId);
              const notif = {
                type: 'executor_request',
                targetId: msg.targetId,
                targetName: room.players.get(msg.targetId)?.name,
                message: msg.message,
              };
              if (criticP) sendTo(criticP, notif);
              if (modP) sendTo(modP, notif);
              sendTo(player, { type: 'night_action_confirmed' });
            }
            break;

          case 'executor_accept':
            if ((player.role === ROLES.CRITIC || playerId === room.moderatorId) && room.executorRequest) {
              room.executorAccepted = true;
              // BUG FIX 1: Notify all to dismiss executor request UI
              broadcast(room, { type: 'executor_request_resolved', accepted: true });
            }
            break;

          case 'executor_reject':
            if ((player.role === ROLES.CRITIC || playerId === room.moderatorId) && room.executorRequest) {
              // BUG FIX 1: Notify all to dismiss executor request UI
              broadcast(room, { type: 'executor_request_resolved', accepted: false });
            }
            break;

          case 'sebastian_action':
            if (player.role === ROLES.SEBASTIAN && room.phase === 'night') {
              room.nightActions.set('sebastian_target', { targetId: msg.targetId, forMafia: msg.forMafia });
            }
            break;
        }
        break;
      }

      case 'mafia_chat': {
        const room = rooms.get(roomCode);
        if (!room) return;
        const player = room.players.get(playerId);
        if (!player || !player.alive || !isMafia(player.role)) return;
        const mafiaMsg = { type: 'mafia_chat', senderName: player.name, message: msg.message };
        room.players.forEach(p => { if (isMafia(p.role)) sendTo(p, mafiaMsg); });
        break;
      }

      case 'day_chat': {
        const room = rooms.get(roomCode);
        if (!room || room.phase !== 'day') return;
        const player = room.players.get(playerId);
        if (!player || !player.alive || room.mutedThisDay.has(playerId)) return;
        broadcast(room, { type: 'day_chat', senderId: playerId, senderName: player.name, message: msg.message });
        break;
      }

      case 'vote': {
        const room = rooms.get(roomCode);
        if (!room || room.phase !== 'day') return;
        const player = room.players.get(playerId);
        // Avocatii nu voteaza
        if (!player || !player.alive || room.mutedThisDay.has(playerId) || player.role === ROLES.AVOCAT) return;
        // Avocatii nu pot fi votati
        const voteTarget = room.players.get(msg.targetId);
        if (voteTarget && voteTarget.role === ROLES.AVOCAT) return;
        room.votes.set(playerId, msg.targetId);
        broadcast(room, { type: 'vote_update', voterId: playerId, targetId: msg.targetId });
        const eligible = Array.from(room.players.values())
          .filter(p => p.alive && !room.mutedThisDay.has(p.id) && p.role !== ROLES.AVOCAT && p.id !== room.moderatorId);
        if (room.votes.size >= eligible.length) resolveFirstVote(room);
        break;
      }

      case 'moderator_resolve_vote': {
        const room = rooms.get(roomCode);
        if (!room || playerId !== room.moderatorId) return;
        resolveFirstVote(room);
        break;
      }

      case 'advocate_defend': {
        const room = rooms.get(roomCode);
        if (!room) return;
        const player = room.players.get(playerId);
        if (!player || player.role !== ROLES.AVOCAT || !player.alive) return;
        if (room.advocateId) return;
        const blocked = room.advocateBlocked.get(playerId) || 0;
        if (blocked > 0) { sendTo(player, { type: 'error', message: 'avocat_blocat' }); return; }
        room.advocateId = playerId;
        broadcast(room, {
          type: 'advocate_defending',
          advocateName: player.name,
          message: msg.message || '',
          defendingPlayerId: room.defendingPlayerId,
        });
        break;
      }

      case 'judge_vote': {
        const room = rooms.get(roomCode);
        if (!room) return;
        const player = room.players.get(playerId);
        if (!player) return;
        if (playerId !== room.moderatorId && (!player.alive || room.mutedThisDay.has(playerId) || player.role === ROLES.AVOCAT)) return;
        room.judgeVotes.set(playerId, msg.vote);
        broadcast(room, { type: 'judge_vote_update', voterId: playerId, vote: msg.vote });
        const eligibleJudge = Array.from(room.players.values()).filter(p =>
          (p.alive && !room.mutedThisDay.has(p.id) && p.role !== ROLES.AVOCAT) || p.id === room.moderatorId
        );
        if (room.judgeVotes.size >= eligibleJudge.length) resolveJudgeVote(room);
        break;
      }

      case 'moderator_resolve_judge': {
        const room = rooms.get(roomCode);
        if (!room || playerId !== room.moderatorId) return;
        resolveJudgeVote(room);
        break;
      }

      case 'moderator_start_day': {
        // BUG FIX 3: Force end night - was missing
        const room = rooms.get(roomCode);
        if (!room || playerId !== room.moderatorId || room.phase !== 'night') return;
        resolveNight(room);
        break;
      }

      case 'moderator_start_night': {
        const room = rooms.get(roomCode);
        if (!room || playerId !== room.moderatorId || room.phase !== 'day') return;
        room.mutedThisDay.clear();
        startNight(room);
        break;
      }
    }
  });

  ws.on('close', () => {
    if (roomCode && playerId) {
      const room = rooms.get(roomCode);
      if (room) {
        const player = room.players.get(playerId);
        if (player) {
          player.ws = null;
          if (room.phase === 'lobby') {
            room.players.delete(playerId);
            broadcast(room, { type: 'player_left', playerId, players: getPublicPlayers(room) });
          }
          if (room.players.size === 0) rooms.delete(roomCode);
        }
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🎭 Mafia Literară v3.2 running on http://localhost:${PORT}`);
});
