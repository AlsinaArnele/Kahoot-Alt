(function(){
  const BOOT = window.QA_BOOTSTRAP || {};
  const LS_KEY = 'quiz_arena_player_v2';
  const state = {
    client: null,
    snapshot: null,
    channel: null,
    gameId: '',
    playerId: '',
    gamePin: '',
    nickname: '',
    serverOffsetMs: 0,
    timerInterval: null,
    pendingAnswer: false,
    loading: false,
    queued: false,
    heartbeat: null
  };
  const stage = document.getElementById('playerStage');
  const errorEl = document.getElementById('playerError');

  const RESTRICTED_TERMS = [
    'resignation','resign','tutam','twoterms','twoterm','rutomustgo','zakayo',
    'fuck','shit','bitch','asshole','cunt','bastard','dick','pussy'
  ];

  function isRestrictedNickname(nickname) {
    const clean = String(nickname || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    return RESTRICTED_TERMS.some(term => clean.includes(term));
  }

  function getUrlPin() {
    try {
      const url = new URL(window.location.href);
      return (url.searchParams.get('pin') || url.searchParams.get('gamePin') || '').trim();
    } catch (err) {
      return '';
    }
  }

  function init() {
    if (!BOOT.supabaseUrl || !BOOT.anonKey) {
      showError('Missing Supabase credentials in config.js.');
      renderJoin();
      return;
    }
    state.client = window.supabase.createClient(BOOT.supabaseUrl, BOOT.anonKey);
    const urlPin = getUrlPin();
    const saved = readSaved();
    if (urlPin) state.gamePin = urlPin;
    if (saved && saved.playerId && (saved.gamePin || urlPin)) {
      state.playerId = saved.playerId;
      state.gamePin = urlPin || saved.gamePin;
      state.nickname = (saved.nickname || '').slice(0, 6);
      loadSnapshot().catch(function(){ renderJoin(); });
    } else {
      renderJoin();
    }
  }

  async function rpc(name, args) {
    const { data, error } = await state.client.rpc(name, args || {});
    if (error) throw new Error(error.message || JSON.stringify(error));
    return data;
  }

  function renderJoin() {
    stage.innerHTML = `
      <div class="card join-card">
        <h1 class="display" style="font-size:36px;margin:0 0 8px;text-align:center;color:var(--cyan-accent)">All hands</h1>
        <p class="subtle" style="text-align:center;margin-bottom:20px">Enter Game PIN and nickname (max 6 letters).</p>
        <form id="joinForm">
          <label class="subtle" for="pinInput">Game PIN</label>
          <input id="pinInput" class="input" inputmode="numeric" autocomplete="one-time-code" value="${escapeAttr(BOOT.gamePin || state.gamePin || getUrlPin() || '')}" maxlength="12" placeholder="123456">
          <label class="subtle" for="nickInput">Nickname (Max 6 letters)</label>
          <input id="nickInput" class="input" maxlength="6" autocomplete="nickname" value="${escapeAttr((state.nickname || '').slice(0, 6))}" placeholder="Name">
          <button class="btn big" style="width:100%" type="submit">Enter Arena</button>
        </form>
      </div>`;
    document.getElementById('joinForm').addEventListener('submit', join);
  }

  async function join(e) {
    e.preventDefault();
    hideError();
    const pin = document.getElementById('pinInput').value.trim();
    let nick = document.getElementById('nickInput').value.trim().slice(0, 6);
    
    if (!pin || !nick) return showError('PIN and Nickname are required.');
    if (nick.length > 6) return showError('Nickname must be 6 characters or fewer.');
    if (isRestrictedNickname(nick)) return showError('Please choose an appropriate nickname.');

    stage.querySelector('button').disabled = true;
    stage.querySelector('button').innerHTML = 'Joining...';
    try {
      const result = await rpc('qa_join_game', { p_game_pin: pin, p_nickname: nick, p_existing_player_id: '' });
      state.playerId = result.player.playerId;
      state.gamePin = result.gamePin || pin;
      state.nickname = (result.player.nickname || nick).slice(0, 6);
      state.gameId = result.gameId;
      savePlayer();
      await loadSnapshot();
      startHeartbeat();
      hideError();
    } catch (err) {
      showError(err.message || err);
      renderJoin();
    }
  }

  async function loadSnapshot() {
    if (!state.playerId || !state.gamePin) throw new Error('Not joined yet.');
    if (state.loading) { state.queued = true; return; }
    state.loading = true;
    try {
      const snap = await rpc('qa_player_snapshot', { p_game_pin: state.gamePin, p_player_id: state.playerId });
      setSnapshot(snap);
      hideError();
    } catch (err) {
      showError(err.message || err);
      throw err;
    } finally {
      state.loading = false;
      if (state.queued) {
        state.queued = false;
        setTimeout(loadSnapshot, 80);
      }
    }
  }

  function setSnapshot(snap) {
    if (!snap || !snap.game || !snap.player) return;
    state.snapshot = snap;
    state.serverOffsetMs = new Date(snap.serverTime).getTime() - Date.now();
    state.gameId = snap.game.id;
    state.playerId = snap.player.playerId;
    state.nickname = (snap.player.nickname || '').slice(0, 6);
    savePlayer();
    maybeSubscribe();
    render();
    startTimerLoop();
    startHeartbeat();
  }

  function maybeSubscribe() {
    if (!state.gameId || state.channel) return;
    state.channel = state.client
      .channel('quiz-arena-player-' + state.gameId + '-' + state.playerId)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'games', filter: 'id=eq.' + state.gameId }, debounceSnapshot)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'game_events', filter: 'game_id=eq.' + state.gameId }, debounceSnapshot)
      .subscribe();
  }

  let debounceHandle = null;
  function debounceSnapshot() {
    clearTimeout(debounceHandle);
    debounceHandle = setTimeout(function(){ loadSnapshot().catch(function(){}); }, 120);
  }

  function startHeartbeat() {
    if (state.heartbeat || !state.playerId || !state.gamePin) return;
    state.heartbeat = setInterval(function(){
      rpc('qa_heartbeat', { p_game_pin: state.gamePin, p_player_id: state.playerId }).catch(function(){});
    }, 15000);
  }

  function nowServerMs() { return Date.now() + state.serverOffsetMs; }
  function startTimerLoop() {
    clearInterval(state.timerInterval);
    state.timerInterval = setInterval(updateTimer, 180);
    updateTimer();
  }
  function updateTimer() {
    const snap = state.snapshot;
    if (!snap || !snap.game || snap.game.status !== 'QUESTION') return;
    const g = snap.game;
    const limit = Number(g.questionTimerLimit || 20);
    const started = new Date(g.questionStartedAt || snap.serverTime).getTime();
    const remaining = Math.max(0, limit - ((nowServerMs() - started) / 1000));
    const timer = document.getElementById('playerTimer');
    if (timer) timer.textContent = String(Math.ceil(remaining));
  }

  function render() {
    const snap = state.snapshot;
    if (!snap) return renderJoin();
    const status = snap.game.status;
    if (status === 'LOBBY' || status === 'PRECOUNTDOWN') return renderWaiting(status);
    if (status === 'QUESTION') return renderQuestionController();
    if (status === 'REVEAL' || status === 'LEADERBOARD') return renderBetweenQuestions(status);
    if (status === 'FINISHED') return renderFinished();
    renderWaiting(status);
  }

  function renderWaiting(status) {
    const p = state.snapshot.player;
    stage.innerHTML = `
      <div class="card join-card" style="text-align:center;">
        ${scoreBadge(p)}
        <h1 class="display" style="font-size:36px;margin:12px 0 8px;color:#2b243d">You're In</h1>
        <p class="subtle">Watch main display for questions.</p>
        <span class="status-pill" style="margin-top:20px;"><span class="status-dot"></span>${escapeHtml(status)}</span>
      </div>`;
  }

  function renderQuestionController() {
    const snap = state.snapshot;
    const p = snap.player;
    const answered = !!snap.answer;
    if (answered || state.pendingAnswer) {
      stage.innerHTML = `
        <div class="card join-card" style="text-align:center;">
          <h1 class="display" style="font-size:32px;margin-bottom:12px;color:#2b243d">Answer Sent</h1>
          <p class="subtle">Check main screen for results.</p>
        </div>`;
      return;
    }

    stage.innerHTML = `
      <div class="card join-card">
        <div style="text-align:center;margin-bottom:16px">
          ${scoreBadge(p)}
          <div style="font-size:28px;font-weight:800;color:var(--cyan-accent);margin-top:8px" id="playerTimer">${Number(snap.game.questionTimerLimit || 20)}</div>
        </div>
        <div class="controller-grid">
          ${['A','B','C','D'].map(function(letter){ 
            return `<button class="controller-btn ${letter}" data-choice="${letter}">${letter}</button>`; 
          }).join('')}
        </div>
      </div>`;
    document.querySelectorAll('[data-choice]').forEach(function(btn){
      btn.addEventListener('click', function(){ submitAnswer(btn.getAttribute('data-choice')); });
    });
    updateTimer();
  }

  async function submitAnswer(choice) {
    if (state.pendingAnswer) return;
    state.pendingAnswer = true;
    document.querySelectorAll('[data-choice]').forEach(function(btn){ btn.disabled = true; });
    try {
      await rpc('qa_submit_answer', {
        p_game_pin: state.gamePin,
        p_player_id: state.playerId,
        p_round: state.snapshot.game.currentRound,
        p_choice: choice
      });
      await loadSnapshot();
    } catch (err) {
      state.pendingAnswer = false;
      showError(err.message || err);
      loadSnapshot().catch(function(){});
    }
  }

  function renderBetweenQuestions(status) {
    state.pendingAnswer = false;
    const p = state.snapshot.player;
    const a = state.snapshot.answer;
    const result = a && a.pointsAwarded !== null ? (a.isCorrect ? 'Correct!' : (a.choice === 'TIMEOUT' ? 'Time Up' : 'Incorrect')) : 'Round Complete';
    const points = a && a.pointsAwarded !== null ? `+${Number(a.pointsAwarded || 0).toLocaleString()} pts` : '';
    
    stage.innerHTML = `
      <div class="card join-card" style="text-align:center;">
        ${scoreBadge(p)}
        <h1 class="display" style="font-size:38px;margin:16px 0 8px;color:${a && a.isCorrect ? 'var(--cyan-accent)' : 'var(--danger)'}">${escapeHtml(result)}</h1>
        <p class="subtle" style="font-size:20px;font-weight:700;">${escapeHtml(points)}</p>
        <div class="card" style="margin-top:20px;padding:16px;background:#f8f6fc">
          <div style="font-size:14px;color:var(--muted)">Current Rank</div>
          <div class="pin" style="font-size:54px">#${p.rank || '—'}</div>
          <div style="font-weight:800;font-size:22px;color:#2b243d">${Number(p.totalScore || 0).toLocaleString()} pts</div>
        </div>
      </div>`;
  }

  function renderFinished() {
    state.pendingAnswer = false;
    const p = state.snapshot.player;
    stage.innerHTML = `
      <div class="card join-card" style="text-align:center;">
        <h1 class="display" style="font-size:38px;margin:10px 0;color:#2b243d">Final Rank</h1>
        <div class="pin" style="font-size:64px">#${p.rank || '—'}</div>
        <div style="font-weight:800;font-size:28px;color:var(--cyan-accent);margin-bottom:12px">${Number(p.totalScore || 0).toLocaleString()} pts</div>
        <button class="btn secondary" id="leaveBtn" style="margin-top:16px">Play Again</button>
      </div>`;
    document.getElementById('leaveBtn').onclick = function(){ localStorage.removeItem(LS_KEY); location.reload(); };
  }

  function scoreBadge(p) {
    const cleanNick = String(p.nickname || '').slice(0, 6);
    return `<div style="display:inline-flex;align-items:center;gap:10px;padding:8px 16px;border-radius:9999px;background:#f8f6fc;border:1px solid var(--border-line);font-size:14px;font-weight:700"><span>${escapeHtml(cleanNick)}</span> • <span>Score: ${Number(p.totalScore || 0).toLocaleString()}</span></div>`;
  }

  function readSaved() {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch (err) { return null; }
  }
  function savePlayer() {
    try { localStorage.setItem(LS_KEY, JSON.stringify({ gamePin: state.gamePin, playerId: state.playerId, nickname: state.nickname.slice(0, 6) })); } catch (err) {}
  }
  function showError(message) { if (errorEl) { errorEl.textContent = String(message || 'Error occurred.'); errorEl.classList.remove('hidden'); } }
  function hideError() { if (errorEl) errorEl.classList.add('hidden'); }
  function escapeHtml(value) { return String(value == null ? '' : value).replace(/[&<>"']/g, function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]; }); }
  function escapeAttr(value) { return escapeHtml(value).replace(/`/g, '&#96;'); }

  window.addEventListener('load', init);
})();
