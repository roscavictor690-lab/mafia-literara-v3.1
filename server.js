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

const MAFIA_ROLES = [ROLES.DON, ROLES.SEBASTIAN, ROLES.MAFIOT];
function isMafia(role) { return MAFIA_ROLES.includes(role); }

// Night sequence order
const NIGHT_SEQUENCE = [
  { role: ROLES.DOCTOR,    duration: 30000,  phase: 'doctor' },
  { role: ROLES.FISC,      duration: 30000,  phase: 'fisc' },
  { role: ROLES.CRITIC,    duration: 60000,  phase: 'critic' },
  // critic_answer handled separately (25s for target)
  { role: null,            duration: 60000,  phase: 'mafia' },
  { role: ROLES.BOSCHETAR, duration: 20000,  phase: 'boschetar' },
  { role: ROLES.EXECUTOR,  duration: 15000,  phase: 'executor_send' },
];

function createRoom(code) {
  return {
    code,
    players: new Map(),
    phase: 'lobby',
    moderatorId: null,
    dayNumber: 0,
    // Day voting
    votes: new Map(),
    advocateId: null,        // first advocate to press defend
    advocateMessage: '',
    advocateRatings: new Map(), // playerId -> rating
    advocateBlocked: new Map(), // playerId -> roundsBlocked
    judgeVotes: new Map(),   // playerId -> 'like'|'dislike'
    defendingPlayerId: null,
    // Night state
    nightPhaseIndex: -1,
    nightTimer: null,
    nightActions: new Map(),
    criticQuestion: null,    // { question, correctAnswer, targetId, askedBy }
    criticAnswered: false,
    executorRequest: null,   // { targetId, message, requesterId }
    executorTimer: null,
    // Day chat log
    dayLog: [],
    // Night result
    nightResult: {},
    // Status effects
    fiscTargetId: null,      // muted for night+day
    mutedThisDay: new Set(),
    // Critic color tracking: criticId -> Map(playerId -> 'green'|'red')
    criticColors: new Map(),
    // Boschetar result
    boschetarVisit: null,    // { vagrantId, visitedId, sawVisitor: bool, visitorName, visitorRole }
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
  // Avocatii sunt neutri permanenti - nu intra in floor(n/3)
  // Calculam mafia din n-2 (fara cei 2 avocati)
  const mafiaTotal = Math.floor((n - 2) / 3);
  roles.push(ROLES.DON);
  roles.push(ROLES.SEBASTIAN);
  for (let i = 2; i < mafiaTotal; i++) roles.push(ROLES.MAFIOT);
  // Roluri speciale fixe
  roles.push(ROLES.CRITIC);
  roles.push(ROLES.AVOCAT);
  roles.push(ROLES.AVOCAT);
  roles.push(ROLES.DOCTOR);
  roles.push(ROLES.FISC);
  roles.push(ROLES.BOSCHETAR);
  roles.push(ROLES.EXECUTOR);
  // Restul = Locuitori Literari-Pasnici
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
    player.ws.send(JSON.stringify({ ...message }));
  }
}

function sendToId(room, playerId, message) {
  const p = room.players.get(playerId);
  if (p) sendTo(p, message);
}

function getPublicPlayers(room) {
  return Array.from(room.players.values()).map(p => ({
    id: p.id, name: p.name, alive: p.alive,
    isModerator: p.id === room.moderatorId,
    muted: room.mutedThisDay.has(p.id),
  }));
}

function getMafiaTeam(room) {
  return Array.from(room.players.values())
    .filter(p => isMafia(p.role))
    .map(p => ({ id: p.id, name: p.name, role: p.role }));
}

function checkWin(room) {
  const alive = Array.from(room.players.values()).filter(p => p.alive && p.id !== room.moderatorId);
  // Avocatii sunt neutri - nu intra in conditia de castig
  const aliveMafia = alive.filter(p => isMafia(p.role));
  const aliveGood = alive.filter(p => !isMafia(p.role) && p.role !== 'avocat');
  if (aliveMafia.length === 0) return 'citizens';
  if (aliveMafia.length >= aliveGood.length) return 'mafia';
  return null;
}

function endGame(room, winner) {
  room.phase = 'ended';
  clearNightTimers(room);
  const allPlayers = Array.from(room.players.values()).map(p => ({
    id: p.id, name: p.name, role: p.role, alive: p.alive,
    advocateRating: room.advocateRatings.get(p.id) || 0,
  }));
  // Best advocate
  let bestAdvocate = null, bestRating = -1;
  allPlayers.forEach(p => {
    if (p.role === ROLES.AVOCAT && p.advocateRating > bestRating) {
      bestRating = p.advocateRating; bestAdvocate = p;
    }
  });
  broadcast(room, { type: 'game_ended', winner, players: allPlayers, bestAdvocate });
}

function clearNightTimers(room) {
  if (room.nightTimer) { clearTimeout(room.nightTimer); room.nightTimer = null; }
  if (room.executorTimer) { clearTimeout(room.executorTimer); room.executorTimer = null; }
}

function addDayLog(room, message) {
  room.dayLog.push(message);
  broadcast(room, { type: 'day_log', message });
}

// ===== NIGHT SEQUENCE =====
function startNight(room) {
  room.phase = 'night';
  room.nightPhaseIndex = -1;
  room.nightActions.clear();
  room.criticQuestion = null;
  room.criticAnswered = false;
  room.executorRequest = null;
  room.boschetarVisit = null;
  room.fiscTargetId = null;
  room.nightResult = {};

  broadcast(room, { type: 'night_started', dayNumber: room.dayNumber, players: getPublicPlayers(room) });

  // Executor writes from start of night (parallel)
  const executor = Array.from(room.players.values()).find(p => p.role === ROLES.EXECUTOR && p.alive);
  if (executor) {
    sendTo(executor, { type: 'night_executor_write', duration: getSequenceTotalDuration(room) });
  }

  advanceNightSequence(room);
}

function getSequenceTotalDuration(room) {
  // sum of all phases
  return NIGHT_SEQUENCE.reduce((sum, s) => sum + s.duration, 0) + 25000; // +25s for critic answer
}

function advanceNightSequence(room) {
  room.nightPhaseIndex++;
  if (room.nightPhaseIndex >= NIGHT_SEQUENCE.length) {
    resolveNight(room);
    return;
  }
  const step = NIGHT_SEQUENCE[room.nightPhaseIndex];

  // Skip if no alive player with this role (except mafia phase)
  if (step.role !== null) {
    const hasPlayer = Array.from(room.players.values()).some(p => p.role === step.role && p.alive);
    if (!hasPlayer) { advanceNightSequence(room); return; }
  }
  if (step.phase === 'mafia') {
    const hasMafia = Array.from(room.players.values()).some(p => isMafia(p.role) && p.alive);
    if (!hasMafia) { advanceNightSequence(room); return; }
  }

  // Notify active player(s)
  room.players.forEach(p => {
    if (!p.alive || p.id === room.moderatorId) return;
    const isActive = step.role ? p.role === step.role : isMafia(p.role);
    sendTo(p, {
      type: 'night_your_turn',
      phase: step.phase,
      active: isActive,
      duration: step.duration,
    });
  });

  // Moderator sees current phase
  const mod = room.players.get(room.moderatorId);
  if (mod) sendTo(mod, { type: 'night_phase_update', phase: step.phase, duration: step.duration });

  room.nightTimer = setTimeout(() => {
    // Auto-advance if no action
    if (step.phase === 'critic') {
      // After critic timer, if question was sent, wait for answer (25s)
      if (room.criticQuestion && !room.criticAnswered) {
        startCriticAnswerTimer(room);
      } else {
        advanceNightSequence(room);
      }
    } else {
      advanceNightSequence(room);
    }
  }, step.duration);
}

function startCriticAnswerTimer(room) {
  const target = room.players.get(room.criticQuestion.targetId);
  if (target) {
    sendTo(target, { type: 'critic_question', question: room.criticQuestion.question, duration: 25000 });
  }
  room.nightTimer = setTimeout(() => {
    // Auto answer with wrong if no response
    if (!room.criticAnswered) {
      processCriticAnswer(room, room.criticQuestion.targetId, null); // null = no answer = random
    }
    advanceNightSequence(room);
  }, 25000);
}

function processCriticAnswer(room, playerId, answer) {
  if (!room.criticQuestion) return;
  room.criticAnswered = true;
  const correct = answer === room.criticQuestion.correctAnswer;
  // Apply fisc/doctor/sebastian effects
  let finalResult = correct;
  if (room.fiscTargetId === playerId) finalResult = false; // fisc overrides to wrong
  // Doctor protection: if doctor saved this player, answer is correct
  const doctorSaved = room.nightActions.get('doctor_saved');
  if (doctorSaved === playerId) finalResult = true;
  // Sebastian: if sebastian targeted this player (give correct to mafioso or wrong to outsider)
  // handled when sebastian action is stored

  // Store for critic to see
  const criticPlayer = Array.from(room.players.values()).find(p => p.role === ROLES.CRITIC);
  if (criticPlayer) {
    if (!room.criticColors.has(criticPlayer.id)) room.criticColors.set(criticPlayer.id, new Map());
    room.criticColors.get(criticPlayer.id).set(playerId, finalResult ? 'green' : 'red');
    sendTo(criticPlayer, { type: 'critic_color_update', targetId: playerId, color: finalResult ? 'green' : 'red' });
  }
}

function resolveNight(room) {
  clearNightTimers(room);
  const actions = room.nightActions;
  const killedThisNight = new Set();

  // Doctor save
  const doctorSavedId = actions.get('doctor_saved');

  // Fisc target
  const fiscTargetId = room.fiscTargetId;
  if (fiscTargetId) {
    room.mutedThisDay.add(fiscTargetId);
  }

  // Mafia kill vote
  const killVotes = new Map();
  actions.forEach((val, key) => {
    if (key.startsWith('mafia_kill_')) {
      killVotes.set(val, (killVotes.get(val) || 0) + 1);
    }
  });
  let mafiaKillTarget = null, maxKV = 0;
  killVotes.forEach((v, tid) => { if (v > maxKV) { maxKV = v; mafiaKillTarget = tid; } });

  // Don takes blame for boschetar
  const don = Array.from(room.players.values()).find(p => p.role === ROLES.DON && p.alive);

  // Boschetar
  if (room.boschetarVisit) {
    const { vagrantId, visitedId } = room.boschetarVisit;
    // Find who visited visitedId this night
    let visitorFound = null;
    actions.forEach((val, key) => {
      if (val === visitedId && key !== `mafia_kill_${vagrantId}`) {
        // find player by action key
        room.players.forEach(p => {
          if (!isMafia(p.role) && actions.get(`visit_${p.id}`) === visitedId) visitorFound = p;
        });
        // For mafia kill: show don if don alive
        if (key.startsWith('mafia_kill_') && mafiaKillTarget === visitedId) {
          visitorFound = don || { name: 'Necunoscut', role: 'mafiot' };
        }
      }
    });
    // Check if mafia killed visitedId
    if (mafiaKillTarget === visitedId && mafiaKillTarget !== doctorSavedId) {
      visitorFound = don || { name: 'Mafiotul', role: 'mafiot' };
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

  // Executor
  let executorKilled = null;
  if (room.executorRequest) {
    const { targetId } = room.executorRequest;
    // Check if critic or moderator accepted
    const criticAccepted = actions.get('executor_critic_accept');
    const modAccepted = actions.get('executor_mod_accept');
    if (criticAccepted || modAccepted) {
      const target = room.players.get(targetId);
      // Avocatii nu pot fi eliminati nici de executor
      if (target && target.alive && targetId !== doctorSavedId && target.role !== 'avocat') {
        target.alive = false;
        killedThisNight.add(targetId);
        executorKilled = { id: target.id, name: target.name, role: target.role };
      }
    }
  }

  // Apply mafia kill
  let mafiaKilled = null;
  if (mafiaKillTarget && mafiaKillTarget !== doctorSavedId && !killedThisNight.has(mafiaKillTarget)) {
    const target = room.players.get(mafiaKillTarget);
    // Avocatii nu pot fi omorati
    if (target && target.alive && target.role !== 'avocat') {
      target.alive = false;
      killedThisNight.add(mafiaKillTarget);
      mafiaKilled = { id: target.id, name: target.name, role: target.role };
    }
  }

  // Build day log messages
  room.dayLog = [];
  const logEntries = [];

  const critic = Array.from(room.players.values()).find(p => p.role === ROLES.CRITIC && p.alive);
  const doctor = Array.from(room.players.values()).find(p => p.role === ROLES.DOCTOR && p.alive);
  const fisc = Array.from(room.players.values()).find(p => p.role === ROLES.FISC && p.alive);
  const boschetar = Array.from(room.players.values()).find(p => p.role === ROLES.BOSCHETAR && p.alive);
  const executorP = Array.from(room.players.values()).find(p => p.role === ROLES.EXECUTOR && p.alive);

  if (doctor && actions.get('doctor_saved')) logEntries.push('Doctorul Lingvist-Literar a salvat pe cineva în această noapte.');
  if (fisc && fiscTargetId) logEntries.push('Fiscul Lingvist-Literar și-a făcut datoria în această noapte.');
  if (critic && room.criticQuestion) logEntries.push('Criticul Lingvist-Literar a depus întrebarea.');
  logEntries.push('Mafia Literară a acționat în umbră.');
  if (boschetar) {
    if (room.boschetarVisit?.sawVisitor) logEntries.push('Boschetarul Lingvist-Literar a venit cu gânduri grele acasă.');
    else logEntries.push('Boschetarul Lingvist-Literar a venit cu o carte acasă.');
  }
  if (executorP && room.executorRequest) logEntries.push('Executorul Lingvist-Literar a trimis o cerere în această noapte.');

  if (mafiaKilled) logEntries.push(`${mafiaKilled.name} a fost eliminat în această noapte.`);
  else if (!executorKilled) logEntries.push('Orașul a dormit liniștit.');
  if (executorKilled) logEntries.push(`${executorKilled.name} a fost executat în această noapte.`);

  room.dayLog = logEntries;
  room.phase = 'day';
  room.dayNumber++;
  room.votes.clear();
  room.judgeVotes.clear();
  room.advocateId = null;
  room.advocateMessage = '';
  room.defendingPlayerId = null;

  // Unblock advocates
  room.advocateBlocked.forEach((rounds, id) => {
    if (rounds > 0) room.advocateBlocked.set(id, rounds - 1);
  });

  const winner = checkWin(room);
  if (winner) { endGame(room, winner); return; }

  broadcast(room, {
    type: 'day_started',
    dayNumber: room.dayNumber,
    players: getPublicPlayers(room),
    dayLog: room.dayLog,
    mafiaKilled,
    executorKilled,
    mutedPlayers: Array.from(room.mutedThisDay),
    criticColors: room.criticColors.size > 0 ? Object.fromEntries(
      Array.from(room.criticColors.entries()).map(([k, v]) => [k, Object.fromEntries(v)])
    ) : {},
  });
}

// ===== VOTE / JUDGE =====
function resolveFirstVote(room) {
  const voteCounts = new Map();
  room.votes.forEach((targetId, voterId) => {
    const voter = room.players.get(voterId);
    if (!voter || room.mutedThisDay.has(voterId)) return;
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

  // Start judge phase
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
    // Critic = 4 votes, moderator = 3 votes
    let weight = 1;
    if (voter.role === ROLES.CRITIC) weight = 4;
    if (voterId === room.moderatorId) weight = 3;
    if (vote === 'like') likes += weight;
    else dislikes += weight;
  });

  const total = likes + dislikes;
  const eliminated = likes > dislikes;

  // Update advocate rating
  if (room.advocateId) {
    const ratio = total > 0 ? dislikes / total : 0;
    const points = ratio * 10;
    const current = room.advocateRatings.get(room.advocateId) || 0;
    room.advocateRatings.set(room.advocateId, +(current + points).toFixed(2));

    // Block advocate if too low
    if (ratio < 0.1) {
      room.advocateBlocked.set(room.advocateId, 2);
    } else if (ratio < 0.4) {
      room.advocateBlocked.set(room.advocateId, 1);
    }
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
        // Check for duplicate name
        const existingWithSameName = Array.from(room.players.values()).find(p => p.name === msg.name);
        const finalName = existingWithSameName ? msg.name + '_1' : msg.name;
        const player = { id: playerId, name: finalName, role: null, alive: true, ws };
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

        // BUG FIX: Reconnect by playerId if exists
        if (msg.playerId && room.players.has(msg.playerId)) {
          playerId = msg.playerId;
          const existing = room.players.get(playerId);
          existing.ws = ws;
          sendTo(existing, { type: 'room_rejoined', code: roomCode, playerId, players: getPublicPlayers(room) });
          broadcast(room, { type: 'player_joined', players: getPublicPlayers(room) }, playerId);
          return;
        }

        // BUG FIX: Also check by name to prevent ghost duplicates
        const existingByName = Array.from(room.players.values()).find(p => p.name === msg.name && !p.ws);
        if (existingByName) {
          playerId = existingByName.id;
          existingByName.ws = ws;
          sendTo(existingByName, { type: 'room_rejoined', code: roomCode, playerId, players: getPublicPlayers(room) });
          broadcast(room, { type: 'player_joined', players: getPublicPlayers(room) }, playerId);
          return;
        }

        playerId = msg.playerId || require('crypto').randomUUID();
        // Strict name dedup - never allow same name
        let finalName = msg.name;
        const names = Array.from(room.players.values()).map(p => p.name);
        let suffix = 2;
        while (names.includes(finalName)) {
          finalName = msg.name + suffix;
          suffix++;
        }
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
        if (gamePlayers.length < 15) {
          sendToId(room, room.moderatorId, { type: 'error', message: 'jucatori_insuficienti' });
          return;
        }
        const roles = assignRoles(gamePlayers.length);
        gamePlayers.forEach((player, i) => { player.role = roles[i]; player.alive = true; });
        room.phase = 'night';
        room.dayNumber = 1;
        // BUG FIX: Send game_started to ALL players with a slight delay to ensure WS is ready
        gamePlayers.forEach(player => {
          const mafiaTeam = isMafia(player.role) ? getMafiaTeam(room) : null;
          // Send twice with delay to ensure delivery (fixes citizens stuck in lobby)
          sendTo(player, { type: 'game_started', role: player.role, mafiaTeam, players: getPublicPlayers(room) });
          setTimeout(() => {
            if (player.ws && player.ws.readyState === WebSocket.OPEN) {
              sendTo(player, { type: 'game_started', role: player.role, mafiaTeam, players: getPublicPlayers(room) });
            }
          }, 500);
        });
        sendToId(room, room.moderatorId, { type: 'game_started', role: 'moderator', players: getPublicPlayers(room) });
        setTimeout(() => startNight(room), 4000);
        break;
      }

      case 'night_action': {
        const room = rooms.get(roomCode);
        if (!room || room.phase !== 'night') return;
        const player = room.players.get(playerId);
        if (!player || !player.alive) return;

        const step = NIGHT_SEQUENCE[room.nightPhaseIndex];

        switch (msg.action) {
          case 'doctor_save':
            if (player.role === ROLES.DOCTOR && step?.phase === 'doctor') {
              room.nightActions.set('doctor_saved', msg.targetId);
              sendTo(player, { type: 'night_action_confirmed' });
              clearTimeout(room.nightTimer);
              advanceNightSequence(room);
            }
            break;
          case 'fisc_mute':
            if (player.role === ROLES.FISC && step?.phase === 'fisc') {
              room.fiscTargetId = msg.targetId;
              sendTo(player, { type: 'night_action_confirmed' });
              clearTimeout(room.nightTimer);
              advanceNightSequence(room);
            }
            break;
          case 'critic_send_question':
            if (player.role === ROLES.CRITIC && step?.phase === 'critic') {
              room.criticQuestion = {
                question: msg.question,
                correctAnswer: msg.correctAnswer,
                targetId: msg.targetId,
                askedBy: playerId,
              };
              sendTo(player, { type: 'night_action_confirmed' });
              clearTimeout(room.nightTimer);
              startCriticAnswerTimer(room);
            }
            break;
          case 'critic_answer':
            if (room.criticQuestion && msg.targetId === room.criticQuestion.targetId && !room.criticAnswered) {
              room.criticAnswered = true;
              processCriticAnswer(room, playerId, msg.answer);
              clearTimeout(room.nightTimer);
              advanceNightSequence(room);
            }
            break;
          case 'mafia_kill':
            if (isMafia(player.role) && step?.phase === 'mafia') {
              room.nightActions.set(`mafia_kill_${playerId}`, msg.targetId);
              sendTo(player, { type: 'night_action_confirmed' });
              // Check if all mafia voted
              const aliveMafia = Array.from(room.players.values()).filter(p => isMafia(p.role) && p.alive);
              const mafiaVotes = aliveMafia.filter(p => room.nightActions.has(`mafia_kill_${p.id}`));
              if (mafiaVotes.length >= aliveMafia.length) {
                clearTimeout(room.nightTimer);
                advanceNightSequence(room);
              }
            }
            break;
          case 'boschetar_visit':
            if (player.role === ROLES.BOSCHETAR && step?.phase === 'boschetar') {
              room.boschetarVisit = { vagrantId: playerId, visitedId: msg.targetId, sawVisitor: false };
              room.nightActions.set(`visit_${playerId}`, msg.targetId);
              sendTo(player, { type: 'night_action_confirmed' });
              clearTimeout(room.nightTimer);
              advanceNightSequence(room);
            }
            break;
          case 'executor_write':
            if (player.role === ROLES.EXECUTOR) {
              room.executorRequest = { targetId: msg.targetId, message: msg.message, requesterId: playerId };
              // Notify critic and moderator
              const criticP = Array.from(room.players.values()).find(p => p.role === ROLES.CRITIC && p.alive);
              const modP = room.players.get(room.moderatorId);
              const notif = { type: 'executor_request', targetId: msg.targetId, targetName: room.players.get(msg.targetId)?.name, message: msg.message };
              if (criticP) sendTo(criticP, notif);
              if (modP) sendTo(modP, notif);
            }
            break;
          case 'executor_accept':
            if (player.role === ROLES.CRITIC) room.nightActions.set('executor_critic_accept', true);
            if (playerId === room.moderatorId) room.nightActions.set('executor_mod_accept', true);
            break;
          case 'executor_reject':
            // just ignore
            break;
          case 'sebastian_action':
            if (player.role === ROLES.SEBASTIAN && step?.phase === 'mafia') {
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
        // Avocatii nu pot vota
        if (!player || !player.alive || room.mutedThisDay.has(playerId) || player.role === 'avocat') return;
        room.votes.set(playerId, msg.targetId);
        broadcast(room, { type: 'vote_update', voterId: playerId, targetId: msg.targetId });
        // Avocatii nu voteaza - nu sunt numarati la eligible
        const eligible = Array.from(room.players.values()).filter(p => p.alive && !room.mutedThisDay.has(p.id) && p.role !== 'avocat');
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
        if (room.advocateId) return; // already taken
        const blocked = room.advocateBlocked.get(playerId) || 0;
        if (blocked > 0) { sendTo(player, { type: 'error', message: 'avocat_blocat' }); return; }
        room.advocateId = playerId;
        room.advocateMessage = msg.message || '';
        broadcast(room, { type: 'advocate_defending', advocateName: player.name, message: room.advocateMessage, defendingPlayerId: room.defendingPlayerId });
        break;
      }

      case 'judge_vote': {
        const room = rooms.get(roomCode);
        if (!room) return;
        const player = room.players.get(playerId);
        // Moderator can vote in judge phase
        if (!player) return;
        // Avocatii nu pot vota nici la judecata
        if (playerId !== room.moderatorId && (!player.alive || room.mutedThisDay.has(playerId) || player.role === 'avocat')) return;
        room.judgeVotes.set(playerId, msg.vote); // 'like' or 'dislike'
        broadcast(room, { type: 'judge_vote_update', voterId: playerId, vote: msg.vote });
        // Check if all eligible voted (alive non-muted + moderator)
        // Avocatii nu voteaza la judecata
        const eligibleJudge = Array.from(room.players.values()).filter(p =>
          ((p.alive && !room.mutedThisDay.has(p.id) && p.role !== 'avocat') || p.id === room.moderatorId)
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
          // Don't delete, just mark disconnected so rejoin works
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
  console.log(`🎭 Mafia Literară v3 running on http://localhost:${PORT}`);
});
