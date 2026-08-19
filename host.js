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
    lastCountdownSec: -1,
    confettiFired: false,
    finishedRendered: false,
    muted: false,
    loading: false,
    snapshotQueued: false
  };

  const els = {
    stage: document.getElementById('hostStage'),
    error: document.getElementById('hostError'),
    status: document.getElementById('statusText'),
    muteBtn: document.getElementById('muteBtn'),
    refreshBtn: document.getElementById('refreshBtn'),
    audioUnlock: document.getElementById('audioUnlock')
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
        <section class="card join-card">
          <h1 class="display" style="font-size:38px;margin:0 0 10px;color:var(--cyan-accent)">All Hands</h1>
          <p class="subtle" style="margin-bottom:18px">Enter Game PIN and Host Token to connect live.</p>
          <form id="roomForm">
            <label class="subtle" for="roomPinInput">Game PIN</label>
            <input id="roomPinInput" class="input" maxlength="20" autocomplete="off" placeholder="123456" value="${escapeAttr(saved.gamePin || '')}">
            <label class="subtle" for="roomTokenInput">Host Token</label>
            <input id="roomTokenInput" class="input" maxlength="120" autocomplete="off" placeholder="Paste host token" value="${escapeAttr(saved.hostToken || '')}">
            <button class="btn big" style="width:100%;margin-top:12px" type="submit">Load Arena</button>
          </form>
        </section>
      </div>`;
    document.getElementById('roomForm').addEventListener('submit', function(e) {
      e.preventDefault();
      const gamePin = document.getElementById('roomPinInput').value.trim();
      const hostToken = document.getElementById('roomTokenInput').value.trim();
      if (!gamePin || !hostToken) return showError('PIN and Host Token are required.');
      BOOT.gamePin = gamePin;
      BOOT.hostToken = hostToken;
      saveRoomCredentials({ gamePin, hostToken });
      hideError();
      state.client = window.supabase.createClient(BOOT.supabaseUrl, BOOT.anonKey);
      loadSnapshot();
    });
  }

  function init() {
    // Force hide audio unlock banner
    if (els.audioUnlock) {
      els.audioUnlock.style.display = 'none';
      els.audioUnlock.classList.add('hidden');
    }

    // Unlock audio seamlessly on first click anywhere
    document.addEventListener('click', function unlockOnce() {
      state.audio.unlock();
      playMusicForStatus();
    }, { once: true });

    if (els.muteBtn) {
      els.muteBtn.addEventListener('click', function(){
        state.muted = !state.muted;
        state.audio.setMuted(state.muted);
        els.muteBtn.textContent = state.muted ? 'Muted' : 'Audio On';
        if (!state.muted) playMusicForStatus();
      });
    }

    if (els.refreshBtn) {
      els.refreshBtn.addEventListener('click', loadSnapshot);
    }

    if (!BOOT.supabaseUrl || !BOOT.anonKey) {
      showError('Missing Supabase URL or anon key in config.js.');
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
    if (els.status) els.status.textContent = snap.game.status || 'READY';

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
        if (eventType === 'ANSWER') {
          state.audio.playSfx(configValue('PopSFX', 'Music/soundreality-pop-sound-423716.mp3'));
        }
        debounceSnapshot();
      })
      .subscribe();
  }

  let debounceHandle = null;
  function debounceSnapshot() {
    clearTimeout(debounceHandle);
    debounceHandle = setTimeout(loadSnapshot, 90);
  }

  function nowServerMs() { return Date.now() + state.serverOffsetMs; }

  function startTimerLoop() {
    clearInterval(state.timerInterval);
    state.timerInterval = setInterval(updateLiveTimer, 160);
    updateLiveTimer();
  }

  function updateLiveTimer() {
    const snap = state.snapshot;
    if (!snap || !snap.game) return;
    const g = snap.game;

    if (g.status === 'PRECOUNTDOWN') {
      const started = new Date(g.precountdownStartedAt || snap.serverTime).getTime();
      const remaining = Math.max(0, 3 - ((nowServerMs() - started) / 1000));
      const currentSec = Math.max(1, Math.ceil(remaining));
      
      const el = document.getElementById('precountdownNumber');
      if (el) {
        if (state.lastCountdownSec !== currentSec) {
          state.lastCountdownSec = currentSec;
          el.textContent = String(currentSec);
          el.classList.remove('bounce-anim');
          void el.offsetWidth;
          el.classList.add('bounce-anim');
        }
      }

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
      const sec = Math.ceil(remaining);
      const timer = document.getElementById('timerNumber');
      const timerCircle = document.getElementById('timerCircle');
      if (timer) timer.textContent = String(sec).padStart(2, '0');
      if (timerCircle) {
        if (sec <= 5) {
          timerCircle.classList.add('warning');
        } else {
          timerCircle.classList.remove('warning');
        }
      }
      if (remaining <= 0.05 && state.revealRequestedFor !== 'reveal-' + g.currentRound) {
        state.revealRequestedFor = 'reveal-' + g.currentRound;
        revealRound('timer');
      }
    }
  }

  function renderHeader() {
    '';
  }

  // Question Metrics Bar (ONLY rendered during live questions / results)
  function renderMetricsBar() {
    const snap = state.snapshot;
    if (!snap || !snap.game) return '';
    const players = snap.players || [];
    const  = snap.totalQuestions || 13;
    return `
      <div class="metrics-bar">
        <div class="metric-cyan">Q: ${escapeHtml(snap.game.currentRound)} / ${totalQuestions}</div>
        <div class="pin-badge">
          <span style="font-size:12px;font-weight:700;color:var(--muted)">PIN:</span>
          <span class="pin-text">${escapeHtml(snap.game.gamePin)}</span>
        </div>
        <div class="metric-cyan" style="display:flex;align-items:center;gap:6px">
          <span>👥</span>
          <span>${players.length.toLocaleString()}</span>
        </div>
      </div>`;
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
    const qrImageUrl = 'https://drive.google.com/thumbnail?id=1fYqyPdvncX8qrOrFT34X61uooLTeVbWD&sz=s1000';

    els.stage.innerHTML = `
      ${renderHeader()}
      <div class="grid host-grid" style="margin-top:20px">
        <section class="card pin-box">
          <div style="text-transform:uppercase;color:var(--cyan-accent);font-weight:800;">Game PIN</div>
          <div class="pin">${escapeHtml(state.snapshot.game.gamePin)}</div>
          <div class="qr-wrap">
            <img src="${qrImageUrl}" alt="Join Game QR Code" />
          </div>
          <p class="subtle">Join at <strong>${escapeHtml(playUrl)}</strong></p>
          <div style="display:flex;gap:12px;justify-content:center;margin-top:20px;">
            <button class="btn big" data-action="advance">Start Game</button>
            <button class="btn secondary" data-action="reset">Reset</button>
          </div>
        </section>
        <aside class="card">
          <h2 style="margin-top:0;color:#2b243d;">Players (${players.length})</h2>
          <div class="players-grid">${players.map(playerChip).join('') || '<p class="subtle">Waiting for players...</p>'}</div>
        </aside>
      </div>`;
    bindActions();
  }

  function renderPrecountdown() {
    const players = state.snapshot.players || [];
    state.lastCountdownSec = 3;
    els.stage.innerHTML = `
      ${renderHeader()}
      ${renderMetricsBar()}
      <section class="card" style="text-align:center;min-height:55vh;display:grid;place-items:center">
        <div>
          <span class="status-pill"><span class="status-dot"></span>GET READY</span>
          <h1 class="display" style="margin-top:16px;color:#2b243d">Question ${escapeHtml(state.snapshot.game.currentRound)}</h1>
          <div id="precountdownNumber" class="pin bounce-anim" style="font-size:clamp(100px,18vw,240px);color:var(--cyan-accent)">3</div>
          <p class="subtle" style="font-size:20px;">${players.length} players connected</p>
          <div style="display:flex;gap:12px;justify-content:center;margin-top:20px;">
            <button class="btn secondary" data-action="advance">Start Now</button>
            <button class="btn danger" data-action="reveal">Skip</button>
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
      return `
        <div class="answer-card ${letter} ${cls}">
          <div class="choice-tag">${letter}</div>
          <div>${escapeHtml(text)}</div>
        </div>`;
    }).join('');

    const distribution = revealed ? renderDistribution(stats, correct) : '';

    els.stage.innerHTML = `
      ${renderHeader()}
      ${renderMetricsBar()}
      <div class="question-box">
        <h1 class="question-title">${escapeHtml(q.question || 'Question')}</h1>
      </div>
      
      ${q.imageUrl ? `<img class="question-image" src="${escapeAttr(q.imageUrl)}" alt="Question image">` : ''}

      <div class="flex flex-col md:flex-row gap-8 items-center justify-center w-full" style="display:flex;gap:24px;align-items:center;justify-content:center;margin-bottom:20px;">
        <div class="timer-container">
          <div id="timerCircle" class="timer-circle">
            <span id="timerNumber" class="display" style="font-size:52px;line-height:1;color:#2b243d">${Number(snap.game.questionTimerLimit || 20)}</span>
            <span style="font-size:11px;letter-spacing:0.1em;margin-top:4px;color:var(--muted);font-weight:700">SECONDS</span>
          </div>
        </div>
      </div>

      <div class="answers">${answers}</div>
      
      ${revealed && (q.explanation || q.funFact) ? `<div class="notice" style="margin-top:20px;"><strong>Explanation:</strong> ${escapeHtml(q.explanation || q.funFact)}</div>` : ''}

      <div style="margin-top:24px;display:flex;justify-content:center">
        ${revealed ? distribution : ''}
        ${revealed ? '<button class="btn big" style="margin-top:16px" data-action="advance">Leaderboard</button>' : '<button class="btn danger" style="margin-top:16px" data-action="reveal">Skip / Reveal</button>'}
      </div>`;
    bindActions();
  }

  function renderDistribution(stats, correct) {
    const max = Math.max(1, stats.A || 0, stats.B || 0, stats.C || 0, stats.D || 0);
    return ['A','B','C','D'].map(function(letter){
      const count = Number(stats[letter] || 0);
      const width = Math.round((count / max) * 100);
      const isCorrect = letter === correct;
      return `<div class="dist-row ${isCorrect ? 'correct-row' : ''}" style="width:100%">
        <div class="answer-card ${letter}" style="min-height:36px;padding:4px;border-radius:8px;display:grid;place-items:center;box-shadow:none;"><div class="choice-tag" style="width:28px;height:28px;font-size:14px">${letter}</div></div>
        <div class="dist-bar"><div class="dist-fill ${letter}" style="--w:${width}%"></div></div>
        <div style="text-align:right; font-weight:800; ${isCorrect ? 'color:var(--cyan-accent);' : ''}">${count}</div>
      </div>`;
    }).join('');
  }

  function renderLeaderboard(finalMode) {
    const rows = state.snapshot.leaderboard || [];
    els.stage.innerHTML = `
      ${renderHeader()}
      ${renderMetricsBar()}
      <section class="card" style="max-width:800px;margin:0 auto">
        <h1 class="display" style="text-align:center;margin-bottom:20px;color:#2b243d">Leaderboard</h1>
        ${rows.map(scoreRow).join('') || '<p class="subtle" style="text-align:center;">No scores yet.</p>'}
        <div style="display:flex;justify-content:center;margin-top:24px">
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
        ${renderHeader()}
        ${renderMetricsBar()}
        <section class="card" style="max-width:850px;margin:0 auto;text-align:center">
          <h1 class="display" style="color:#2b243d">Final Podium</h1>
          <div class="podium">
            ${podiumPlace(podium[0], '2', 'second', 'pod-2')}
            ${podiumPlace(podium[1], '1', 'first', 'pod-1')}
            ${podiumPlace(podium[2], '3', 'third', 'pod-3')}
          </div>
          <h2 style="margin-top:32px; color:#2b243d;">Top 10</h2>
          <div style="text-align:left">${rows.map(scoreRow).join('') || '<p class="subtle">No players.</p>'}</div>
          <div style="display:flex;justify-content:center;margin-top:28px">
            <button class="btn danger" data-action="reset">Reset Arena</button>
          </div>
        </section>`;
      bindActions();
      state.finishedRendered = true;
      state.confettiFired = false;

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

    if (status !== prevStatus) {
      state.audio.stopAll();

      if (status === 'PRECOUNTDOWN') {
        state.audio.playSfx(configValue('CountdownSFX', 'Music/321-countdown.mp3'), 1.0);
      } else if (status === 'QUESTION') {
        state.revealRequestedFor = '';
        playMusicForStatus();
      } else if (status === 'REVEAL') {
        state.audio.playSfx(configValue('RevealSFX', 'Music/Kahoot Gong Sound Effect.mp3'));
      } else if (status === 'LEADERBOARD') {
        const leaderboardSfx = configValue('LeaderboardSFX', '');
        if (leaderboardSfx) state.audio.playSfx(leaderboardSfx);
        state.audio.playMusic(configValue('LeaderboardMusic', 'Music/leaderboard-theme.mp3'), false);
      } else if (status === 'FINISHED') {
        state.audio.playSfx(configValue('ApplauseSFX', 'Music/u_xg7ssi08yr-crowd-cheering-379666.mp3'));
        state.audio.playMusic(configValue('PodiumMusic', 'Music/Drum Roll (Ending Celebration) - Sound Effect _ ProSounds.mp3'), false);
      } else if (status === 'LOBBY') {
        playMusicForStatus();
      }
    }

    if (status === 'QUESTION' && prevStatus === 'QUESTION' && Number(stats.total || 0) > state.lastAnswerTotal) {
      state.audio.playSfx(configValue('PopSFX', 'Music/soundreality-pop-sound-423716.mp3'));
    }

    state.lastAnswerTotal = Number(stats.total || 0);
    state.lastStatus = status;
  }

  function playMusicForStatus() {
    if (state.muted) return;
    const status = state.snapshot && state.snapshot.game ? state.snapshot.game.status : '';
    
    if (status === 'LOBBY') {
      return state.audio.playMusic(configValue('LobbyMusic', 'Music/Kahoot Lobby Music.mp3'), true);
    }
    if (status === 'QUESTION') {
      const round = parseInt(state.snapshot.game.currentRound || '1', 10) || 1;
      const key = 'ThinkMusic' + (((round - 1) % 3) + 1);
      const defaults = [
        'Music/Kahoot In Game Music (20 Second Countdown) 2_3.mp3',
        'Music/Kahoot In Game Music (20 Second Countdown) 3_3.mp3',
        'Music/Kahoot Music (30 Second Countdown) 2_3.mp3'
      ];
      return state.audio.playMusic(configValue(key, defaults[(round - 1) % 3]), true);
    }
    if (status === 'LEADERBOARD') {
      return state.audio.playMusic(configValue('LeaderboardMusic', 'Music/leaderboard-theme.mp3'), false);
    }
    if (status === 'FINISHED') {
      return state.audio.playMusic(configValue('PodiumMusic', 'Music/Drum Roll (Ending Celebration) - Sound Effect _ ProSounds.mp3'), false);
    }
  }

  function configValue(keyName, defaultPath) {
    const cfg = (state.snapshot && state.snapshot.config) || {};
    const wanted = norm(keyName);
    
    const keys = Object.keys(cfg);
    for (let k = 0; k < keys.length; k++) {
      if (norm(keys[k]) === wanted) {
        const val = String(cfg[keys[k]] || '').trim();
        if (isValidAudioValue(val)) {
          return encodeURI(val);
        }
      }
    }
    
    return defaultPath ? encodeURI(defaultPath) : '';
  }

  function isValidAudioValue(val) {
    if (!val) return false;
    const lower = val.toLowerCase().trim();
    if (
      lower.includes('url') || 
      lower.includes('sound fx') || 
      lower.includes('music') || 
      lower.includes('your_') ||
      lower.includes('paste')
    ) {
      return false;
    }
    return true;
  }

  function norm(v) { return String(v || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
  
  // Truncate player nickname to max 6 characters
  function cleanNick(name) { return String(name || '').slice(0, 6); }

  function playerChip(p) { return `<div class="player-chip"><span class="avatar" style="background:${escapeAttr(p.avatarColor || '#2b243d')}">${escapeHtml(cleanNick(p.nickname).slice(0,1).toUpperCase())}</span><span>${escapeHtml(cleanNick(p.nickname))}</span></div>`; }
  function scoreRow(p, i) { return `<div class="scoreboard-row"><div class="rank">#${p.rank || i + 1}</div><div class="name">${escapeHtml(cleanNick(p.nickname))}</div><div class="score">${Number(p.totalScore || 0).toLocaleString()} pt</div></div>`; }
  
  function podiumPlace(p, rankNum, cls, id) { 
    const revealStyling = id ? 'opacity:0; transform:translateY(50px); transition: all 0.8s cubic-bezier(0.34, 1.56, 0.64, 1);' : '';
    return `<div id="${id || ''}" class="podium-place ${cls}" style="${revealStyling}"><div class="podium-rank">${rankNum}</div><div class="podium-name">${p ? escapeHtml(cleanNick(p.nickname)) : '—'}</div><div class="podium-score">${p ? Number(p.totalScore || 0).toLocaleString() + ' pt' : ''}</div></div>`; 
  }

  function playerUrl() {
    const url = new URL('play.html', window.location.href);
    url.searchParams.set('pin', state.snapshot && state.snapshot.game ? state.snapshot.game.gamePin : (BOOT.gamePin || ''));
    return url.toString();
  }

  function fireConfetti() {
    if (!window.confetti) return;
    confetti({ particleCount: 180, spread: 90, origin: { y: .75 }, colors: ['#2b243d', '#00dbe7', '#e60039', '#e0a900'] });
  }

  function showError(message) { if (els.error) { els.error.textContent = String(message || 'Error occurred.'); els.error.classList.remove('hidden'); } }
  function hideError() { if (els.error) els.error.classList.add('hidden'); }
  function escapeHtml(value) { return String(value == null ? '' : value).replace(/[&<>"']/g, function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]; }); }
  function escapeAttr(value) { return escapeHtml(value).replace(/`/g, '&#96;'); }

  window.addEventListener('load', init);
})();
