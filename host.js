(function(){
  const BOOT = window.QA_BOOTSTRAP || {};
  const state = {
    client: null,
    audio: new window.QuizArenaAudio(),
    snapshot: null,
    channel: null,
    gameId: '',
    serverOffsetMs: 0,
    timerInterval: null,
    revealRequestedFor: '',
    lastAnswerTotal: 0,
    lastStatus: '',
    confettiFired: false,
    finishedRendered: false, // Ensures podium animation only triggers once per finish
    muted: false,
    loading: false,
    snapshotQueued: false
  };

  const els = {
    stage: document.getElementById('hostStage'),
    error: document.getElementById('hostError'),
    notice: document.getElementById('hostNotice'),
    status: document.getElementById('statusText'),
    muteBtn: document.getElementById('muteBtn'),
    refreshBtn: document.getElementById('refreshBtn'),
    audioUnlock: document.getElementById('audioUnlock'),
    unlockAudioBtn: document.getElementById('unlockAudioBtn'),
    skipAudioBtn: document.getElementById('skipAudioBtn')
  };

  const ROOM_STORAGE_KEY = 'quiz_arena_host_room_v1';

  function readRoomCredentials() {
    const fromUrl = new URL(window.location.href);
    const gamePin = (fromUrl.searchParams.get('pin') || fromUrl.searchParams.get('gamePin') || '').trim();
    const hostToken = (fromUrl.searchParams.get('token') || fromUrl.searchParams.get('hostToken') || '').trim();
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(ROOM_STORAGE_KEY) || 'null'); } catch (err) {}
    return {
      gamePin: gamePin || (saved && saved.gamePin) || (BOOT.gamePin || '') || '',
      hostToken: hostToken || (saved && saved.hostToken) || (BOOT.hostToken || '') || ''
    };
  }

  function saveRoomCredentials(creds) {
    try {
      localStorage.setItem(ROOM_STORAGE_KEY, JSON.stringify({
        gamePin: creds.gamePin || '',
        hostToken: creds.hostToken || ''
      }));
    } catch (err) {}
  }

  function renderRoomSetup() {
    const saved = readRoomCredentials();
    els.stage.innerHTML = `
      <div class="grid host-grid">
        <section class="card join-card" style="width:100%">
          <h1 class="display" style="font-size:54px;margin:0 0 10px">Open a Room</h1>
          <p class="subtle" style="margin-bottom:18px">Paste the current Game PIN and Host Token for this Supabase room. They stay in your browser only.</p>
          <form id="roomForm">
            <label class="subtle" for="roomPinInput">Game PIN</label>
            <input id="roomPinInput" class="input" maxlength="20" autocomplete="off" placeholder="123456" value="${escapeAttr(saved.gamePin || '')}">
            <label class="subtle" for="roomTokenInput">Host Token</label>
            <input id="roomTokenInput" class="input" maxlength="120" autocomplete="off" placeholder="Paste host token" value="${escapeAttr(saved.hostToken || '')}">
            <button class="btn big" style="width:100%;margin-top:12px" type="submit">Load Arena</button>
          </form>
        </section>
        <aside class="card">
          <h2 style="margin-top:0; color:var(--primary2)">Player link</h2>
          <p class="subtle">Once the room loads, the QR code will point to <code>play.html?pin=YOUR_PIN</code>.</p>
          <p class="subtle">GitHub Pages hosts the UI only; Supabase stores the live game state.</p>
        </aside>
      </div>`;
    const form = document.getElementById('roomForm');
    form.addEventListener('submit', function(e) {
      e.preventDefault();
      const gamePin = document.getElementById('roomPinInput').value.trim();
      const hostToken = document.getElementById('roomTokenInput').value.trim();
      if (!gamePin) return showError('Game PIN is required.');
      if (!hostToken) return showError('Host Token is required.');
      BOOT.gamePin = gamePin;
      BOOT.hostToken = hostToken;
      saveRoomCredentials({ gamePin, hostToken });
      hideError();
      state.client = window.supabase.createClient(BOOT.supabaseUrl, BOOT.anonKey);
      loadSnapshot();
    });
  }

  function init() {
    els.unlockAudioBtn.addEventListener('click', function(){
      state.audio.unlock();
      els.audioUnlock.classList.add('hidden');
      playMusicForStatus();
    });
    els.skipAudioBtn.addEventListener('click', function(){
      state.muted = true;
      state.audio.setMuted(true);
      els.audioUnlock.classList.add('hidden');
      els.muteBtn.textContent = '🔇 Muted';
    });
    els.muteBtn.addEventListener('click', function(){
      state.muted = !state.muted;
      state.audio.setMuted(state.muted);
      els.muteBtn.textContent = state.muted ? '🔇 Muted' : '🔊 Audio';
      if (!state.muted) playMusicForStatus(true);
    });
    els.refreshBtn.addEventListener('click', loadSnapshot);

    if (!BOOT.supabaseUrl || !BOOT.anonKey) {
      showError('Missing Supabase URL or anon key. Check config.js.');
      return;
    }
    const creds = readRoomCredentials();
    BOOT.gamePin = creds.gamePin || BOOT.gamePin || '';
    BOOT.hostToken = creds.hostToken || BOOT.hostToken || '';
    state.client = window.supabase.createClient(BOOT.supabaseUrl, BOOT.anonKey);
    if (BOOT.gamePin && BOOT.hostToken) {
      saveRoomCredentials({ gamePin: BOOT.gamePin, hostToken: BOOT.hostToken });
      loadSnapshot();
    } else {
      renderRoomSetup();
    }
  }

  async function rpc(name, args) {
    const { data, error } = await state.client.rpc(name, args || {});
    if (error) throw new Error(error.message || JSON.stringify(error));
    return data;
  }

  async function loadSnapshot() {
    if (state.loading) { state.snapshotQueued = true; return; }
    state.loading = true;
    try {
      const snap = await rpc('qa_host_snapshot', { p_game_pin: BOOT.gamePin, p_host_token: BOOT.hostToken });
      setSnapshot(snap);
      hideError();
    } catch (err) {
      showError(err.message || err);
    } finally {
      state.loading = false;
      if (state.snapshotQueued) {
        state.snapshotQueued = false;
        setTimeout(loadSnapshot, 60);
      }
    }
  }

  function setSnapshot(snap) {
    if (!snap || !snap.game) return;
    const previous = state.snapshot;
    state.snapshot = snap;
    state.serverOffsetMs = new Date(snap.serverTime).getTime() - Date.now();
    state.gameId = snap.game.id;
    els.status.textContent = snap.game.status || 'READY';

    if (snap.game.status !== 'FINISHED') {
      state.finishedRendered = false;
    }

    maybeSubscribe();
    handleAudioTransitions(previous, snap);
    render();
    startTimerLoop();
  }

  function maybeSubscribe() {
    if (!state.gameId || state.channel) return;
    state.channel = state.client
      .channel('quiz-arena-host-' + state.gameId)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'games', filter: 'id=eq.' + state.gameId }, debounceSnapshot)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'players', filter: 'game_id=eq.' + state.gameId }, debounceSnapshot)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'game_events', filter: 'game_id=eq.' + state.gameId }, function(payload){
        const eventType = payload && payload.new ? payload.new.event_type : '';
        if (eventType === 'ANSWER') state.audio.playSfx(configValue('PopSFX', 'Pop Sound FX URL'));
        debounceSnapshot();
      })
      .subscribe(function(status){
        if (status === 'SUBSCRIBED') showNotice('Realtime connected. Live gameplay is running directly on Supabase.');
      });
  }

  let debounceHandle = null;
  function debounceSnapshot() {
    clearTimeout(debounceHandle);
    debounceHandle = setTimeout(loadSnapshot, 90);
  }

  function nowServerMs() { return Date.now() + state.serverOffsetMs; }

  function startTimerLoop() {
    clearInterval(state.timerInterval);
    state.timerInterval = setInterval(function(){
      updateLiveTimer();
    }, 160);
    updateLiveTimer();
  }

  function updateLiveTimer() {
    const snap = state.snapshot;
    if (!snap || !snap.game) return;
    const g = snap.game;

    if (g.status === 'PRECOUNTDOWN') {
      const started = new Date(g.precountdownStartedAt || snap.serverTime).getTime();
      const remaining = Math.max(0, 3 - ((nowServerMs() - started) / 1000));
      const el = document.getElementById('precountdownNumber');
      if (el) el.textContent = String(Math.max(1, Math.ceil(remaining)));
      if (remaining <= 0.05 && state.revealRequestedFor !== 'begin-' + g.currentRound) {
        state.revealRequestedFor = 'begin-' + g.currentRound;
        advanceGame();
      }
      return;
    }

    if (g.status === 'QUESTION') {
      const limit = Number(g.questionTimerLimit || 20);
      const started = new Date(g.questionStartedAt || snap.serverTime).getTime();
      const elapsed = Math.max(0, (nowServerMs() - started) / 1000);
      const remaining = Math.max(0, limit - elapsed);
      const pct = Math.max(0, Math.min(100, (remaining / limit) * 100));
      const sec = Math.ceil(remaining);
      const timer = document.getElementById('timerNumber');
      const ring = document.getElementById('timerRing');
      if (timer) timer.textContent = String(sec);
      if (ring) ring.style.setProperty('--pct', pct + '%');
      if (remaining <= 0.05 && state.revealRequestedFor !== 'reveal-' + g.currentRound) {
        state.revealRequestedFor = 'reveal-' + g.currentRound;
        revealRound('timer');
      }
    }
  }

  function render() {
    const snap = state.snapshot;
    if (!snap || !snap.game) return;
    const status = snap.game.status;
    if (status === 'LOBBY') return renderLobby();
    if (status === 'PRECOUNTDOWN') return renderPrecountdown();
    if (status === 'QUESTION') return renderQuestion(false);
    if (status === 'REVEAL') return renderQuestion(true);
    if (status === 'LEADERBOARD') return renderLeaderboard(false);
    if (status === 'FINISHED') return renderFinished();
    els.stage.innerHTML = '<div class="card"><h1>Unknown status</h1></div>';
  }

  function renderLobby() {
    const players = state.snapshot.players || [];
    const playUrl = playerUrl();
    const qrImageUrl = 'https://drive.google.com/thumbnail?id=1KRcIO7_UqpbC0q-ZFmYQPp9L-uzWlQbv&sz=s1000';

    els.stage.innerHTML = `
      <div class="grid host-grid">
        <section class="card pin-box">
          <div class="pin-label">Game PIN</div>
          <div class="pin">${escapeHtml(state.snapshot.game.gamePin)}</div>
          <div class="qr-wrap">
            <img src="${qrImageUrl}" alt="Join Game QR Code" style="width:180px; height:180px; object-fit:contain; display:block;" />
          </div>
          <p class="subtle">Players join at <strong>${escapeHtml(playUrl)}</strong></p>
          <div class="actions" style="justify-content:center;margin-top:22px">
            <button class="btn big" data-action="advance">Start Game</button>
            <button class="btn secondary" data-action="reset">Reset room</button>
          </div>
        </section>
        <aside class="card">
          <h2 style="margin-top:0; color:var(--primary2)">Joined Players <span class="subtle">(${players.length})</span></h2>
          <div class="players-grid">${players.map(playerChip).join('') || '<p class="subtle">No players yet. Gates are open.</p>'}</div>
        </aside>
      </div>`;
    bindActions();
  }

  function renderPrecountdown() {
    const players = state.snapshot.players || [];
    els.stage.innerHTML = `
      <section class="card" style="text-align:center;min-height:68vh;display:grid;place-items:center">
        <div>
          <p class="status-pill" style="margin:auto auto 18px;width:max-content"><span class="status-dot"></span>GET READY</p>
          <h1 class="display">Question ${escapeHtml(state.snapshot.game.currentRound)}</h1>
          <div id="precountdownNumber" class="pin" style="font-size:clamp(110px,20vw,280px)">3</div>
          <p class="subtle" style="font-size:22px">${players.length} players in the arena</p>
          <div class="actions" style="justify-content:center;margin-top:20px">
            <button class="btn secondary" data-action="advance">Start now</button>
            <button class="btn danger" data-action="reveal">Skip / Reveal</button>
          </div>
        </div>
      </section>`;
    bindActions();
  }

  function renderQuestion(revealed) {
    const snap = state.snapshot;
    const q = snap.question || {};
    const stats = snap.answerStats || { A:0, B:0, C:0, D:0, total:0 };
    const active = Number(snap.activePlayerCount || 0);
    const correct = String(q.correct || '').toUpperCase();
    const answers = ['A','B','C','D'].map(function(letter){
      const text = q['option' + letter] || q['option' + letter.toLowerCase()] || '';
      const cls = revealed ? (letter === correct ? 'correct' : 'dim') : '';
      return `<div class="answer-card ${letter} ${cls}"><div class="shape">${shape(letter)}</div><div>${escapeHtml(text)}</div></div>`;
    }).join('');

    const distribution = revealed ? renderDistribution(stats, correct) : '';
    const meta = [q.category, q.difficulty, q.doublePoints ? 'DOUBLE POINTS' : ''].filter(Boolean).map(escapeHtml).join(' • ');
    els.stage.innerHTML = `
      <div class="grid host-grid">
        <section class="card">
          <div style="display:flex;justify-content:space-between;gap:14px;align-items:center;flex-wrap:wrap;margin-bottom:16px">
            <span class="status-pill"><span class="status-dot"></span>Round ${escapeHtml(snap.game.currentRound || '')}</span>
            <span class="subtle">${meta}</span>
          </div>
          <h1 class="question-title">${escapeHtml(q.question || 'Question')}</h1>
          ${q.imageUrl ? `<img class="question-image" src="${escapeAttr(q.imageUrl)}" alt="Question image">` : ''}
          <div class="answers">${answers}</div>
          ${revealed && (q.explanation || q.funFact) ? `<div class="notice" style="margin-top:24px"><strong>${q.explanation ? 'Explanation' : 'Fun fact'}:</strong> ${escapeHtml(q.explanation || q.funFact)}</div>` : ''}
        </section>
        <aside class="card">
          ${revealed ? '<h2 style="margin-top:0; color:var(--primary)">Answer Reveal</h2>' : '<h2 style="margin-top:0; color:var(--primary)">Live Responses</h2>'}
          ${revealed ? distribution : `
            <div id="timerRing" class="timer-ring"><div class="timer-ring-inner"><span id="timerNumber">${Number(snap.game.questionTimerLimit || 20)}</span></div></div>
            <p class="counter" style="margin-top:24px">${Number(stats.total || 0)} / ${active} answered</p>
          `}
          <div class="actions" style="justify-content:center;margin-top:32px">
            ${revealed ? '<button class="btn big" data-action="advance">Show leaderboard</button>' : '<button class="btn danger big" data-action="reveal">Skip / Reveal</button>'}
          </div>
        </aside>
      </div>`;
    bindActions();
  }

  function renderDistribution(stats, correct) {
    const max = Math.max(1, stats.A || 0, stats.B || 0, stats.C || 0, stats.D || 0);
    return ['A','B','C','D'].map(function(letter){
      const count = Number(stats[letter] || 0);
      const width = Math.round((count / max) * 100);
      const isCorrect = letter === correct;
      return `<div class="dist-row ${isCorrect ? 'correct-row' : ''}">
        <div class="answer-card ${letter}" style="min-height:44px;padding:6px;border-radius:12px;display:grid;place-items:center;grid-template-columns:1fr;box-shadow:none;">${shape(letter)}</div>
        <div class="dist-bar"><div class="dist-fill ${letter}" style="--w:${width}%"></div></div>
        <div style="text-align:right; font-weight:800; ${isCorrect ? 'color:var(--primary2);' : ''}">${count}</div>
      </div>`;
    }).join('');
  }

  function renderLeaderboard(finalMode) {
    const rows = state.snapshot.leaderboard || [];
    els.stage.innerHTML = `
      <section class="card" style="max-width:850px;margin:0 auto">
        <h1 class="display" style="text-align:center;margin-bottom:22px">Leaderboard</h1>
        ${rows.map(scoreRow).join('') || '<p class="subtle" style="text-align:center;">No scores yet.</p>'}
        <div class="actions" style="justify-content:center;margin-top:32px">
          <button class="btn big" data-action="advance">${finalMode ? 'Finish' : 'Next Question'}</button>
        </div>
      </section>`;
    bindActions();
  }

  function renderFinished() {
    const rows = state.snapshot.leaderboard || [];
    
    if (!state.finishedRendered) {
      const podium = [rows[1], rows[0], rows[2]];
      els.stage.innerHTML = `
        <section class="card" style="max-width:900px;margin:0 auto;text-align:center">
          <h1 class="display">Final Podium</h1>
          <div class="podium">
            ${podiumPlace(podium[0], '🥈', 'second', 'pod-2')}
            ${podiumPlace(podium[1], '🏆', 'first', 'pod-1')}
            ${podiumPlace(podium[2], '🥉', 'third', 'pod-3')}
          </div>
          <h2 style="margin-top:40px; color:var(--primary);">Top 10</h2>
          <div style="text-align:left">${rows.map(scoreRow).join('') || '<p class="subtle">No players.</p>'}</div>
          <div class="actions" style="justify-content:center;margin-top:32px">
            <button class="btn danger" data-action="reset">Reset room</button>
          </div>
        </section>`;
      bindActions();
      state.finishedRendered = true;
      state.confettiFired = false;

      // Sequential reveal animations for places 3, 2, and 1
      setTimeout(function() {
        const el = document.getElementById('pod-3');
        if(el) { el.style.opacity = 1; el.style.transform = 'translateY(0)'; }
      }, 600);

      setTimeout(function() {
        const el = document.getElementById('pod-2');
        if(el) { el.style.opacity = 1; el.style.transform = 'translateY(0)'; }
      }, 1600);

      setTimeout(function() {
        const el = document.getElementById('pod-1');
        if(el) { el.style.opacity = 1; el.style.transform = 'translateY(0)'; }
        if (!state.confettiFired) {
            state.confettiFired = true;
            fireConfetti();
        }
      }, 2800);
    }
  }

  function bindActions() {
    document.querySelectorAll('[data-action="advance"]').forEach(function(btn){ btn.onclick = advanceGame; });
    document.querySelectorAll('[data-action="reveal"]').forEach(function(btn){ btn.onclick = function(){ revealRound('host'); }; });
    document.querySelectorAll('[data-action="reset"]').forEach(function(btn){ btn.onclick = resetGame; });
  }

  async function advanceGame() {
    try {
      state.finishedRendered = false;
      const snap = await rpc('qa_advance_game', { p_game_pin: BOOT.gamePin, p_host_token: BOOT.hostToken });
      setSnapshot(snap);
    } catch (err) { showError(err.message || err); }
  }

  async function revealRound(reason) {
    try {
      state.finishedRendered = false;
      const snap = await rpc('qa_reveal_round', { p_game_pin: BOOT.gamePin, p_host_token: BOOT.hostToken, p_reason: reason || 'host' });
      setSnapshot(snap);
    } catch (err) { showError(err.message || err); }
  }

  async function resetGame() {
    if (!confirm('Reset the room and remove players/scores?')) return;
    state.confettiFired = false;
    state.finishedRendered = false;
    state.revealRequestedFor = '';
    try {
      const snap = await rpc('qa_reset_game', { p_game_pin: BOOT.gamePin, p_host_token: BOOT.hostToken, p_keep_players: false });
      setSnapshot(snap);
    } catch (err) { showError(err.message || err); }
  }

  function handleAudioTransitions(prev, next) {
    const prevStatus = prev && prev.game ? prev.game.status : '';
    const status = next.game.status;
    const stats = next.answerStats || {};
    if (status === 'QUESTION' && prevStatus !== 'QUESTION') state.revealRequestedFor = '';
    if (status === 'REVEAL' && prevStatus !== 'REVEAL') {
      state.audio.playSfx(configValue('RevealSFX', 'Reveal Sound FX URL'));
    }
    if (status === 'FINISHED' && prevStatus !== 'FINISHED') {
      state.audio.playSfx(configValue('ApplauseSFX', 'Applause Sound FX URL'));
      state.audio.playMusic(configValue('PodiumMusic', 'Podium Music URL'), true);
    } else if (status !== prevStatus) {
      playMusicForStatus(true);
    }
    if (status === 'QUESTION' && prevStatus === 'QUESTION' && Number(stats.total || 0) > state.lastAnswerTotal) {
      state.audio.playSfx(configValue('PopSFX', 'Pop Sound FX URL'));
    }
    state.lastAnswerTotal = Number(stats.total || 0);
    state.lastStatus = status;
  }

  function playMusicForStatus(force) {
    if (state.muted) return;
    const status = state.snapshot && state.snapshot.game ? state.snapshot.game.status : '';
    if (status === 'LOBBY') return state.audio.playMusic(configValue('LobbyMusic', 'Lobby Music URL'), true);
    if (status === 'QUESTION') {
      const round = parseInt(state.snapshot.game.currentRound || '1', 10) || 1;
      const key = 'ThinkMusic' + (((round - 1) % 3) + 1);
      return state.audio.playMusic(configValue(key, 'Question Music ' + (((round - 1) % 3) + 1) + ' URL'), true);
    }
    if (status === 'FINISHED') return state.audio.playMusic(configValue('PodiumMusic', 'Podium Music URL'), true);
    if (force && ['REVEAL','LEADERBOARD','PRECOUNTDOWN'].indexOf(status) !== -1) state.audio.stopMusic();
  }

  function configValue() {
    const cfg = (state.snapshot && state.snapshot.config) || {};
    for (let i = 0; i < arguments.length; i++) {
      const wanted = norm(arguments[i]);
      const keys = Object.keys(cfg);
      for (let k = 0; k < keys.length; k++) {
        if (norm(keys[k]) === wanted && cfg[keys[k]]) return cfg[keys[k]];
      }
    }
    return '';
  }

  function norm(v) { return String(v || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
  function shape(letter) { return ({ A:'▲', B:'✕', C:'●', D:'■' })[letter] || letter; }
  function playerChip(p) { return `<div class="player-chip"><span class="avatar" style="background:${escapeAttr(p.avatarColor || '#8b5cf6')}">${escapeHtml((p.nickname || '?').slice(0,1).toUpperCase())}</span><span>${escapeHtml(p.nickname || '')}</span></div>`; }
  function scoreRow(p, i) { return `<div class="scoreboard-row"><div class="rank">#${p.rank || i + 1}</div><div class="name">${escapeHtml(p.nickname || '')}</div><div class="score">${Number(p.totalScore || 0).toLocaleString()} pt</div></div>`; }
  
  function podiumPlace(p, medal, cls, id) { 
    const revealStyling = id ? 'opacity:0; transform:translateY(50px); transition: all 0.8s cubic-bezier(0.34, 1.56, 0.64, 1);' : '';
    return `<div id="${id || ''}" class="podium-place ${cls}" style="${revealStyling}"><div class="podium-medal">${medal}</div><div class="podium-name">${p ? escapeHtml(p.nickname) : '—'}</div><div class="podium-score">${p ? Number(p.totalScore || 0).toLocaleString() + ' pt' : ''}</div></div>`; 
  }

  function playerUrl() {
    const url = new URL('play.html', window.location.href);
    url.searchParams.set('pin', state.snapshot && state.snapshot.game ? state.snapshot.game.gamePin : (BOOT.gamePin || ''));
    return url.toString();
  }

  function fireConfetti() {
    if (!window.confetti) return;
    confetti({ particleCount: 180, spread: 90, origin: { y: .75 }, colors: ['#8b5cf6', '#7c3aed', '#ffffff', '#f59e0b'] });
    setTimeout(function(){ confetti({ particleCount: 140, spread: 120, origin: { x: .15, y: .7 }, colors: ['#8b5cf6', '#7c3aed', '#ffffff'] }); }, 450);
    setTimeout(function(){ confetti({ particleCount: 140, spread: 120, origin: { x: .85, y: .7 }, colors: ['#8b5cf6', '#7c3aed', '#ffffff'] }); }, 800);
  }

  function showError(message) { els.error.textContent = String(message || 'Something went wrong.'); els.error.classList.remove('hidden'); }
  function hideError() { els.error.classList.add('hidden'); }
  function showNotice(message) { els.notice.textContent = message; els.notice.classList.remove('hidden'); setTimeout(function(){ els.notice.classList.add('hidden'); }, 3000); }
  function escapeHtml(value) { return String(value == null ? '' : value).replace(/[&<>"']/g, function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]; }); }
  function escapeAttr(value) { return escapeHtml(value).replace(/`/g, '&#96;'); }

  window.addEventListener('load', init);
})();
