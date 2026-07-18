/* ============================================================================
 * app.js — FreeCell "The Vault" — UI, interaction, persistence, juice.
 * Depends (as global <script>s): game.js, solver.js, deals.js.
 * ========================================================================== */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const LS = {
    save: 'vault.save', stats: 'vault.stats', settings: 'vault.settings',
  };

  /* ------------------------------- settings ------------------------------ */
  const settings = Object.assign(
    { sound: true, haptics: true, light: false },
    load(LS.settings) || {}
  );
  function saveSettings() { store(LS.settings, settings); applyTheme(); }
  function applyTheme() { document.body.classList.toggle('light', !!settings.light); }
  applyTheme();

  /* ------------------------------- sound --------------------------------- */
  let AC = null;
  function ac() {
    if (!AC) AC = new (window.AudioContext || window.webkitAudioContext)();
    if (AC.state === 'suspended') AC.resume();
    return AC;
  }
  function tone(freq, dur, type, vol, when, slideTo) {
    if (!settings.sound) return;
    type = type || 'sine'; vol = vol == null ? 0.18 : vol; when = when || 0;
    const c = ac(), t = c.currentTime + when;
    const o = c.createOscillator(), g = c.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(c.destination); o.start(t); o.stop(t + dur + 0.02);
  }
  function noise(dur, vol, when, lp) {
    if (!settings.sound) return;
    const c = ac(), t = c.currentTime + (when || 0);
    const n = Math.floor(c.sampleRate * dur), buf = c.createBuffer(1, n, c.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
    const s = c.createBufferSource(); s.buffer = buf;
    const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = lp || 1800;
    const g = c.createGain(); g.gain.setValueAtTime(vol || 0.15, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f).connect(g).connect(c.destination); s.start(t); s.stop(t + dur + 0.02);
  }
  const sfx = {
    pickup() { tone(520, 0.09, 'triangle', 0.12, 0, 660); },
    place() { noise(0.05, 0.10, 0, 2600); tone(300, 0.05, 'square', 0.05); },
    foundation() { tone(1180, 0.10, 'sine', 0.14); tone(1560, 0.12, 'sine', 0.10, 0.04); },
    invalid() { tone(150, 0.16, 'sawtooth', 0.10, 0, 110); noise(0.06, 0.06, 0, 500); },
    cascade() { for (let i = 0; i < 6; i++) tone(900 + i * 120, 0.05, 'sine', 0.07, i * 0.05); },
    win() {
      noise(0.5, 0.18, 0, 320);
      [392, 523, 659, 784, 1047].forEach((f, i) => tone(f, 0.5, 'triangle', 0.13, 0.12 + i * 0.09));
    },
    record() { [1047, 1319, 1568, 2093].forEach((f, i) => tone(f, 0.35, 'sine', 0.10, i * 0.07)); },
  };
  function buzz(pattern) { if (settings.haptics && navigator.vibrate) navigator.vibrate(pattern); }

  /* ------------------------------- state --------------------------------- */
  let game = null;         // Game instance
  let curTier = 3;         // 1..5
  let sel = null;          // { fromType, fromIdx, n, cards:Set, grab }
  let busy = false;        // animation / auto-solve in progress -> lock input
  let timer = { base: 0, startedAt: null, finalMs: null };
  let tickHandle = null;
  let countedPlayed = false;

  const cardEls = new Array(52);
  const geom = { cardW: 40, cardH: 56, gap: 5, topY: 0, tableauTop: 80, fanY: 16, slotX: [] };

  /* ---------------------------- start screen ----------------------------- */
  function renderStart() {
    const stats = getStats();
    const list = $('tierList');
    list.innerHTML = '';
    for (let t = 1; t <= 5; t++) {
      const b = document.createElement('button');
      b.className = 'tier' + (t === 5 ? ' t5' : '');
      const st = stats[t] || {};
      const best = st.bestMs ? fmt(st.bestMs) : null;
      const fk = t === 5 ? '<span class="t-fk">3 free cells</span>' : '';
      b.innerHTML =
        `<span class="t-name"><span class="t-dot"></span><span class="t-nm">${TIER_NAMES[t - 1]}</span>${fk}</span>` +
        `<span class="t-best">${best ? 'best <b>' + best + '</b>' : '<span class="t-lock">— not cracked yet</span>'}</span>`;
      b.addEventListener('click', () => { unlockAudio(); startNewGame(t); });
      list.appendChild(b);
    }
    // continue
    const save = load(LS.save);
    const cont = $('continueBtn');
    if (save && save.state) {
      cont.hidden = false;
      $('continueDesc').textContent = `${TIER_NAMES[save.tier - 1]} · ${fmt(save.elapsedMs || 0)} elapsed`;
      cont.onclick = () => { unlockAudio(); resumeGame(save); };
    } else cont.hidden = true;
  }

  function showScreen(which) {
    $('startScreen').hidden = which !== 'start';
    $('gameScreen').hidden = which !== 'game';
  }

  /* ---------------------------- game lifecycle --------------------------- */
  function pickDeal(tier) {
    const pool = (typeof DEAL_POOL !== 'undefined' && DEAL_POOL[tier]) || null;
    if (pool && pool.length) return pool[(Math.random() * pool.length) | 0];
    // fallback: grade on the fly (should not happen once deals.js is built)
    const g = generateDeal(tier, (Date.now() & 0x7fffffff));
    return g ? g.dealNumber : 1;
  }

  function startNewGame(tier, dealNumber) {
    // count the just-abandoned game as a loss for streak purposes
    if (game && !game.won && game.moveCount > 0) breakStreak(curTier);
    curTier = tier;
    const dn = dealNumber || pickDeal(tier);
    const numFree = TIER_FREE_CELLS[tier - 1];
    game = new Game(dn, numFree);
    bumpPlayed(tier);
    countedPlayed = true;
    beginGameUI();
  }

  function resumeGame(save) {
    curTier = save.tier;
    game = Game.fromSnapshot({
      dealNumber: save.dealNumber, numFree: save.numFree,
      state: save.state, moveCount: save.moveCount, won: false,
    });
    countedPlayed = true; // already counted when originally started
    timer = { base: save.elapsedMs || 0, startedAt: null, finalMs: null };
    beginGameUI(true);
  }

  function beginGameUI(resumed) {
    sel = null; busy = false;
    $('hudTier').textContent = TIER_NAMES[curTier - 1];
    if (!resumed) timer = { base: 0, startedAt: null, finalMs: null };
    stopWinFx();
    showScreen('game');
    buildBoardDom();
    layout();
    render();
    updateHud();
    startTimer();
    autosave();
  }

  /* ------------------------------ board DOM ------------------------------ */
  function buildBoardDom() {
    const board = $('board');
    board.innerHTML = '';
    geom.slotEls = { free: [], found: [] };
    geom.colzones = [];
    // column drop zones (behind cards)
    for (let c = 0; c < 8; c++) {
      const z = document.createElement('div');
      z.className = 'colzone';
      z.addEventListener('click', () => onColumnTap(c));
      board.appendChild(z);
      geom.colzones.push(z);
    }
    // free cell slots
    for (let i = 0; i < game.numFree; i++) {
      const s = document.createElement('div');
      s.className = 'slot free';
      s.addEventListener('click', () => onFreeTap(i));
      board.appendChild(s);
      geom.slotEls.free.push(s);
    }
    // foundation slots
    for (let su = 0; su < 4; su++) {
      const s = document.createElement('div');
      s.className = 'slot found';
      s.innerHTML = `<span class="slot-glyph">${SUIT_GLYPH[su]}</span>`;
      s.addEventListener('click', () => onFoundationTap(su));
      board.appendChild(s);
      geom.slotEls.found.push(s);
    }
    // empty-column markers (shown only when a column is empty; also a drop target)
    geom.slotEls.col = [];
    for (let c = 0; c < 8; c++) {
      const s = document.createElement('div');
      s.className = 'slot col';
      s.addEventListener('click', () => onColumnTap(c));
      board.appendChild(s);
      geom.slotEls.col.push(s);
    }
    // 52 card elements
    for (let c = 0; c < 52; c++) {
      const el = document.createElement('div');
      el.className = 'card ' + (isRed(c) ? 'red' : 'black');
      el.innerHTML =
        `<span class="r">${RANK_LABEL[rankOf(c)]}</span>` +
        `<span class="s">${SUIT_GLYPH[suitOf(c)]}</span>` +
        `<span class="big">${SUIT_GLYPH[suitOf(c)]}</span>`;
      el.style.transform = 'translate(0px,0px)';
      el.addEventListener('click', (e) => { e.stopPropagation(); onCardTap(c); });
      el.addEventListener('dblclick', (e) => { e.stopPropagation(); onCardDouble(c); });
      cardEls[c] = el;
      board.appendChild(el);
    }
  }

  function layout() {
    const board = $('board');
    const W = board.clientWidth, H = board.clientHeight;
    const gap = Math.max(4, Math.round(W * 0.012));
    const cardW = Math.floor((W - 7 * gap) / 8);
    const cardH = Math.round(cardW * 1.4);
    geom.gap = gap; geom.cardW = cardW; geom.cardH = cardH;
    geom.topY = 2;
    geom.tableauTop = geom.topY + cardH + Math.round(cardH * 0.34);
    geom.slotX = [];
    for (let i = 0; i < 8; i++) geom.slotX.push(i * (cardW + gap));

    // size cards
    for (let c = 0; c < 52; c++) {
      const el = cardEls[c];
      el.style.width = cardW + 'px'; el.style.height = cardH + 'px';
      el.querySelector('.r').style.fontSize = Math.round(cardW * 0.34) + 'px';
      el.querySelector('.s').style.fontSize = Math.round(cardW * 0.30) + 'px';
      el.querySelector('.big').style.fontSize = Math.round(cardW * 0.7) + 'px';
    }
    // free slots (left), foundations (right 4)
    for (let i = 0; i < game.numFree; i++) placeSlot(geom.slotEls.free[i], geom.slotX[i], geom.topY, cardW, cardH);
    for (let su = 0; su < 4; su++) placeSlot(geom.slotEls.found[su], geom.slotX[4 + su], geom.topY, cardW, cardH);
    for (let c = 0; c < 8; c++) placeSlot(geom.slotEls.col[c], geom.slotX[c], geom.tableauTop, cardW, cardH);
    // column zones
    for (let c = 0; c < 8; c++) {
      const z = geom.colzones[c];
      z.style.left = geom.slotX[c] + 'px'; z.style.top = geom.tableauTop + 'px';
      z.style.width = cardW + 'px'; z.style.height = (H - geom.tableauTop) + 'px';
    }
  }
  function placeSlot(el, x, y, w, h) {
    el.style.left = x + 'px'; el.style.top = y + 'px';
    el.style.width = w + 'px'; el.style.height = h + 'px';
  }

  /* -------------------------------- render ------------------------------- */
  function render() {
    const s = game.state;
    const H = $('board').clientHeight;
    // dynamic fan so the tallest column fits
    let maxLen = 7;
    for (const col of s.cols) if (col.length > maxLen) maxLen = col.length;
    const avail = H - geom.tableauTop - geom.cardH;
    geom.fanY = Math.max(12, Math.min(Math.round(geom.cardH * 0.30), Math.floor(avail / Math.max(1, maxLen - 1))));

    // reset per-card selection class handled separately
    const place = (c, x, y, z) => {
      const el = cardEls[c];
      el.style.setProperty('--tx', x + 'px');
      el.style.setProperty('--ty', y + 'px');
      if (!el.classList.contains('sel')) el.style.transform = `translate(${x}px,${y}px)`;
      el.style.zIndex = z;
    };
    // tableau
    for (let c = 0; c < 8; c++) {
      const col = s.cols[c];
      // show the recessed marker only when the column is empty
      if (geom.slotEls.col) geom.slotEls.col[c].style.display = col.length ? 'none' : 'block';
      for (let d = 0; d < col.length; d++) {
        place(col[d], geom.slotX[c], geom.tableauTop + d * geom.fanY, 10 + d);
      }
    }
    // free cells
    for (let i = 0; i < s.free.length; i++) {
      if (s.free[i] != null) place(s.free[i], geom.slotX[i], geom.topY, 20);
    }
    // foundations (stack all placed ranks at the slot; top rank shows)
    for (let su = 0; su < 4; su++) {
      for (let r = 1; r <= s.found[su]; r++) {
        const c = ((r - 1) << 2) | su;
        place(c, geom.slotX[4 + su], geom.topY, 20 + r);
      }
    }
  }

  function refreshSelClasses() {
    for (let c = 0; c < 52; c++) cardEls[c].classList.remove('sel', 'hint-src', 'hint-dst', 'drop-ok');
    document.querySelectorAll('.slot').forEach((s) => s.classList.remove('drop-ok'));
    if (!sel || !sel.cards) return;
    sel.cards.forEach((c) => cardEls[c].classList.add('sel'));
    highlightDropTargets();
  }

  // Glow every legal destination for the current selection — so empty columns
  // (any card, including a King, is welcome there) are obviously tappable.
  function highlightDropTargets() {
    const s = game.state, n = sel.n, bottom = sel.grab;
    const freeEmpty = countEmptyFree(s), emptyCols = countEmptyCols(s);
    if (n === 1) {
      for (let i = 0; i < s.free.length; i++) if (s.free[i] == null) geom.slotEls.free[i].classList.add('drop-ok');
      if (canToFoundation(bottom, s.found)) geom.slotEls.found[suitOf(bottom)].classList.add('drop-ok');
    }
    for (let c = 0; c < 8; c++) {
      if (sel.fromType === 'col' && sel.fromIdx === c) continue;
      const dst = s.cols[c], toEmpty = dst.length === 0;
      if (n > maxSupermove(freeEmpty, emptyCols, toEmpty)) continue;
      if (toEmpty) geom.slotEls.col[c].classList.add('drop-ok');
      else if (canStack(bottom, dst[dst.length - 1])) cardEls[dst[dst.length - 1]].classList.add('drop-ok');
    }
  }

  /* ------------------------------ interaction ---------------------------- */
  function locateCard(c) {
    const s = game.state;
    for (let i = 0; i < 8; i++) { const idx = s.cols[i].indexOf(c); if (idx >= 0) return { loc: 'col', idx: i, depth: idx }; }
    for (let i = 0; i < s.free.length; i++) if (s.free[i] === c) return { loc: 'free', idx: i };
    if (rankOf(c) <= s.found[suitOf(c)]) return { loc: 'found', idx: suitOf(c) };
    return null;
  }

  function trySelectColumnRun(colIdx, cardIdx) {
    const col = game.state.cols[colIdx];
    const n = col.length - cardIdx;
    // cards from cardIdx..top must be a valid descending alt-color run
    for (let k = 0; k < n - 1; k++) {
      if (!canStack(col[cardIdx + 1 + k], col[cardIdx + k])) return null;
    }
    const cards = new Set(col.slice(cardIdx));
    return { fromType: 'col', fromIdx: colIdx, n, cards, grab: col[cardIdx] };
  }

  function onCardTap(c) {
    if (busy || !game || game.won) return;
    unlockAudio();
    const here = locateCard(c);
    if (!here) return;

    if (sel) {
      if (sel.cards.has(c)) {
        // re-tap on selection: try foundation if single, else deselect
        if (sel.n === 1 && tryMove(destFoundation(sel.grab))) return;
        clearSel(); return;
      }
      // destination = this card's location
      if (here.loc === 'col') { tryMove({ toType: 'col', toIdx: here.idx }); return; }
      if (here.loc === 'found') { tryMove({ toType: 'found', toIdx: here.idx }); return; }
      // tapping an occupied free cell -> invalid target
      invalidFeedback(sel.cards); return;
    }

    // no selection: select source
    if (here.loc === 'col') {
      const s = trySelectColumnRun(here.idx, here.depth);
      if (!s) { sfx.invalid(); shakeCards(new Set([c])); buzz(30); return; }
      // enforce that the run can actually move somewhere size-wise later; select anyway
      sel = s; sfx.pickup(); refreshSelClasses(); render();
    } else if (here.loc === 'free') {
      sel = { fromType: 'free', fromIdx: here.idx, n: 1, cards: new Set([c]), grab: c };
      sfx.pickup(); refreshSelClasses(); render();
    }
  }

  function onCardDouble(c) {
    if (busy || !game || game.won) return;
    const here = locateCard(c);
    if (!here || here.loc === 'found') return;
    // only the movable top single can go to foundation
    if (here.loc === 'col' && here.depth !== game.state.cols[here.idx].length - 1) return;
    clearSel();
    tryMove(destFoundation(c), { fromType: here.loc === 'col' ? 'col' : 'free', fromIdx: here.idx, n: 1, grab: c });
  }

  function onColumnTap(c) {
    if (busy || !game || game.won || !sel) return;
    tryMove({ toType: 'col', toIdx: c });
  }
  function onFreeTap(i) {
    if (busy || !game || game.won) return;
    unlockAudio();
    const card = game.state.free[i];
    if (sel) {
      if (card == null) tryMove({ toType: 'free', toIdx: i });
      else if (sel.cards.has(card)) clearSel();
      else invalidFeedback(sel.cards);
    } else if (card != null) {
      sel = { fromType: 'free', fromIdx: i, n: 1, cards: new Set([card]), grab: card };
      sfx.pickup(); refreshSelClasses(); render();
    }
  }
  function onFoundationTap(su) {
    if (busy || !game || game.won || !sel) return;
    tryMove({ toType: 'found', toIdx: su });
  }

  function destFoundation(card) { return { toType: 'found', toIdx: suitOf(card) }; }

  // Assemble + apply a move from current selection (or an explicit source).
  function tryMove(dest, srcOverride) {
    const src = srcOverride || sel;
    if (!src) return false;
    const m = { fromType: src.fromType, fromIdx: src.fromIdx, n: src.n, toType: dest.toType, toIdx: dest.toIdx };
    const cards = src.cards || new Set([src.grab]);
    if (game.doMove(m)) {
      if (dest.toType === 'found') { sfx.foundation(); }
      else { sfx.place(); }
      clearSel();
      render();
      updateHud();
      autosave();
      afterMove();
      return true;
    }
    invalidFeedback(cards);
    return false;
  }

  function invalidFeedback(cards) {
    sfx.invalid(); buzz(40); shakeCards(cards);
  }
  function shakeCards(cards) {
    cards.forEach((c) => {
      const el = cardEls[c];
      el.classList.remove('shake'); void el.offsetWidth; el.classList.add('shake');
      setTimeout(() => el.classList.remove('shake'), 340);
    });
  }
  function clearSel() { sel = null; refreshSelClasses(); render(); }

  function afterMove() {
    updateUndo();
    if (game.won) { onWin(); return; }
    // auto-finish once the board can be completed by foundation moves alone
    if (canAutoFinish(game.state)) {
      busy = true;
      setTimeout(() => playFoundationFinish(), 220);
    }
  }

  /* ---------------------------- auto / finish ---------------------------- */
  // Greedy: can the game be won using only foundation moves from here?
  function canAutoFinish(state) {
    const s = cloneState(state);
    let progressed = true;
    while (progressed && !isWin(s)) {
      progressed = false;
      // any exposed card that fits its foundation
      for (let i = 0; i < 8; i++) {
        const col = s.cols[i];
        if (col.length && canToFoundation(col[col.length - 1], s.found)) {
          s.found[suitOf(col[col.length - 1])]++; col.pop(); progressed = true;
        }
      }
      for (let i = 0; i < s.free.length; i++) {
        const c = s.free[i];
        if (c != null && canToFoundation(c, s.found)) { s.found[suitOf(c)]++; s.free[i] = null; progressed = true; }
      }
    }
    return isWin(s);
  }

  function nextFoundationMove(state) {
    for (let i = 0; i < 8; i++) {
      const col = state.cols[i];
      if (col.length && canToFoundation(col[col.length - 1], state.found))
        return { fromType: 'col', fromIdx: i, toType: 'found', toIdx: suitOf(col[col.length - 1]), n: 1 };
    }
    for (let i = 0; i < state.free.length; i++) {
      const c = state.free[i];
      if (c != null && canToFoundation(c, state.found))
        return { fromType: 'free', fromIdx: i, toType: 'found', toIdx: suitOf(c), n: 1 };
    }
    return null;
  }

  function playFoundationFinish() {
    const step = () => {
      const m = nextFoundationMove(game.state);
      if (!m) { busy = false; if (isWin(game.state)) onWin(); return; }
      game.doMove(m); sfx.foundation(); render(); updateHud(); autosave();
      setTimeout(step, 90);
    };
    step();
  }

  // "Auto" button: send all currently-safe cards to foundations.
  function autoSafe() {
    if (busy || !game || game.won) return;
    unlockAudio();
    const m0 = safeAutoMove(game.state);
    if (!m0 && !canAutoFinish(game.state)) { toast('No safe moves'); return; }
    busy = true;
    const step = () => {
      const m = safeAutoMove(game.state);
      if (!m) {
        busy = false;
        if (canAutoFinish(game.state) && !game.won) { busy = true; setTimeout(playFoundationFinish, 120); }
        else if (game.won) onWin();
        return;
      }
      game.doMove(m); sfx.foundation(); render(); updateHud(); autosave();
      setTimeout(step, 100);
    };
    step();
  }

  /* -------------------------------- hint --------------------------------- */
  function showHint() {
    if (busy || !game || game.won) return;
    unlockAudio();
    toast('Consulting the ledger…');
    setTimeout(() => {
      const res = solve(game.state, { maxNodes: 250000, weight: 3, wantPath: true });
      if (!res.solvable || !res.path.length) { toast('No winning line found from here'); return; }
      const m = res.path[0];
      highlightMove(m);
    }, 20);
  }
  function highlightMove(m) {
    for (let c = 0; c < 52; c++) cardEls[c].classList.remove('hint-src', 'hint-dst');
    const s = game.state;
    let srcCard = null;
    if (m.fromType === 'col') srcCard = s.cols[m.fromIdx][s.cols[m.fromIdx].length - m.n];
    else srcCard = s.free[m.fromIdx];
    if (srcCard != null) cardEls[srcCard].classList.add('hint-src');
    if (m.toType === 'col' && s.cols[m.toIdx].length) {
      cardEls[s.cols[m.toIdx][s.cols[m.toIdx].length - 1]].classList.add('hint-dst');
    }
    sfx.pickup();
    setTimeout(() => { for (let c = 0; c < 52; c++) cardEls[c].classList.remove('hint-src', 'hint-dst'); }, 1800);
  }

  function autoSolve() {
    if (busy || !game || game.won) return;
    closeSheet();
    toast('Cracking the vault…');
    setTimeout(() => {
      const res = solve(game.state, { maxNodes: 400000, weight: 3, wantPath: true });
      if (!res.solvable) { toast('No solution found from here'); return; }
      busy = true; sel = null; refreshSelClasses();
      const path = res.path.slice();
      let k = 0;
      const step = () => {
        if (k >= path.length) { busy = false; if (game.won) onWin(); return; }
        const m = path[k++];
        game.doMove(m);
        if (m.toType === 'found') sfx.foundation(); else sfx.place();
        render(); updateHud();
        if (game.won) { busy = false; autosave(); onWin(); return; }
        setTimeout(step, 130);
      };
      step();
    }, 20);
  }

  /* -------------------------------- undo --------------------------------- */
  function undo() {
    if (busy || !game) return;
    if (game.undo()) { sfx.pickup(); clearSel(); render(); updateHud(); updateUndo(); autosave(); }
  }
  function updateUndo() { $('undoBtn').disabled = !game || !game.canUndo(); }

  /* -------------------------------- timer -------------------------------- */
  function startTimer() {
    if (timer.startedAt == null) timer.startedAt = Date.now();
    if (tickHandle) clearInterval(tickHandle);
    tickHandle = setInterval(updateHud, 500);
  }
  function pauseTimer() {
    if (timer.startedAt != null) { timer.base += Date.now() - timer.startedAt; timer.startedAt = null; }
    if (tickHandle) { clearInterval(tickHandle); tickHandle = null; }
  }
  function elapsedMs() {
    if (timer.finalMs != null) return timer.finalMs;
    return timer.base + (timer.startedAt != null ? Date.now() - timer.startedAt : 0);
  }

  function updateHud() {
    if (!game) return;
    $('hudTime').textContent = fmt(elapsedMs());
    $('hudMoves').textContent = game.moveCount + (game.moveCount === 1 ? ' move' : ' moves');
    updateUndo();
  }

  /* -------------------------------- win ---------------------------------- */
  function onWin() {
    // capture final time BEFORE anything freezes it
    const finalMs = elapsedMs();
    timer.finalMs = finalMs;
    pauseTimer();
    busy = true;
    localStorage.removeItem(LS.save);
    const isRecord = recordWin(curTier, finalMs);
    updateHud();
    $('wbSub').textContent = `${TIER_NAMES[curTier - 1]} · ${fmt(finalMs)}`;
    $('wbRecord').hidden = !isRecord;
    startWinFx(isRecord);
  }

  /* ---- win cascade (canvas) ---- */
  let winCtx, winCards = [], winRaf = null, winRunning = false, winSpawn = 0, winIdx = 0;
  const WSUITS = [0, 1, 2, 3], WRANKS = 13;
  function sizeWinCanvas() {
    const r = $('gameScreen').getBoundingClientRect();
    const cv = $('winCanvas'); cv.width = r.width; cv.height = r.height;
  }
  function startWinFx(record) {
    const cv = $('winCanvas');
    sizeWinCanvas(); cv.style.display = 'block'; cv.style.opacity = '1'; cv.style.transition = '';
    winCtx = cv.getContext('2d'); winCtx.clearRect(0, 0, cv.width, cv.height);
    winCards = []; winIdx = 0; winSpawn = 0; winRunning = true;
    $('winBanner').hidden = false;
    $('winBanner').animate(
      [{ opacity: 0, transform: 'translateY(12px) scale(.95)' }, { opacity: 1, transform: 'none' }],
      { duration: 460, easing: 'cubic-bezier(.2,.9,.3,1.35)' });
    sfx.win();
    if (record) setTimeout(() => sfx.record(), 650);
    buzz(record ? [40, 50, 40, 50, 90] : [40, 60, 130]);
    winFrame();
  }
  function drawWinCard(c) {
    const ctx = winCtx, w = Math.max(26, geom.cardW * 0.8), h = w * 1.4;
    ctx.save(); ctx.translate(c.x, c.y); ctx.rotate(c.rot);
    ctx.fillStyle = 'rgba(0,0,0,.25)'; rr(ctx, -w / 2 + 1, -h / 2 + 2, w, h, 5); ctx.fill();
    ctx.fillStyle = '#F4EFE2'; rr(ctx, -w / 2, -h / 2, w, h, 5); ctx.fill();
    ctx.lineWidth = 1.2; ctx.strokeStyle = '#C9A227'; rr(ctx, -w / 2, -h / 2, w, h, 5); ctx.stroke();
    ctx.fillStyle = (c.suit === 1 || c.suit === 2) ? '#B03A2E' : '#16130c';
    ctx.font = '700 ' + Math.round(w * 0.34) + 'px Inter, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText(RANK_LABEL[c.rank], -w / 2 + 4, -h / 2 + 3);
    ctx.font = Math.round(w * 0.4) + 'px serif'; ctx.fillText(SUIT_GLYPH[c.suit], -w / 2 + 4, -h / 2 + w * 0.38);
    ctx.restore();
  }
  function rr(ctx, x, y, w, h, r) {
    ctx.beginPath(); ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  function winFrame() {
    if (!winRunning) return;
    const cv = $('winCanvas');
    winCtx.fillStyle = 'rgba(18,53,40,0.12)'; winCtx.fillRect(0, 0, cv.width, cv.height);
    winSpawn++;
    if (winSpawn % 4 === 0 && winIdx < 78) {
      const fx = [cv.width * 0.60, cv.width * 0.70, cv.width * 0.80, cv.width * 0.90][winIdx % 4];
      winCards.push({
        x: fx, y: geom.topY + geom.cardH * 0.5 + 6, vx: -(2 + Math.random() * 3.4), vy: -(1 + Math.random() * 2.2),
        rot: 0, vr: (Math.random() - .5) * 0.16, suit: WSUITS[(Math.random() * 4) | 0], rank: 1 + ((Math.random() * WRANKS) | 0),
      });
      winIdx++;
      if (winIdx % 2 === 0) tone(700 + Math.random() * 500, 0.04, 'sine', 0.05);
    }
    const g = 0.34, floor = cv.height - 20;
    for (const c of winCards) {
      c.vy += g; c.x += c.vx; c.y += c.vy; c.rot += c.vr;
      if (c.y > floor) { c.y = floor; c.vy *= -0.6; c.vx *= 0.98; if (Math.abs(c.vy) < 1.4) c.vy -= Math.random() * 2; }
      drawWinCard(c);
    }
    winCards = winCards.filter((c) => c.x > -50 && c.x < cv.width + 50);
    winRaf = requestAnimationFrame(winFrame);
    // wind down
    if (winSpawn > 260) {
      winRunning = false; if (winRaf) cancelAnimationFrame(winRaf);
      const cvv = $('winCanvas');
      cvv.style.transition = 'opacity .55s ease'; cvv.style.opacity = '0';
      setTimeout(() => { cvv.style.display = 'none'; winCtx && winCtx.clearRect(0, 0, cvv.width, cvv.height); }, 600);
    }
  }
  function stopWinFx() {
    winRunning = false; if (winRaf) cancelAnimationFrame(winRaf);
    const cv = $('winCanvas'); cv.style.display = 'none'; cv.style.opacity = '1'; cv.style.transition = '';
    $('winBanner').hidden = true; winCards = [];
  }

  /* ------------------------------- stats --------------------------------- */
  function getStats() { return load(LS.stats) || {}; }
  function setStats(s) { store(LS.stats, s); }
  function tierStat(s, t) { if (!s[t]) s[t] = { played: 0, wins: 0, bestMs: null, totalWinMs: 0, streak: 0, bestStreak: 0 }; return s[t]; }
  function bumpPlayed(t) { const s = getStats(); tierStat(s, t).played++; setStats(s); }
  function breakStreak(t) { const s = getStats(); tierStat(s, t).streak = 0; setStats(s); }
  function recordWin(t, ms) {
    const s = getStats(); const st = tierStat(s, t);
    const prevBest = st.bestMs;
    st.wins++; st.streak++; if (st.streak > st.bestStreak) st.bestStreak = st.streak;
    st.totalWinMs += ms;
    const record = (prevBest == null) || ms < prevBest; // first crack, or a new best time
    if (record) st.bestMs = ms;
    setStats(s);
    return record;
  }

  /* ---------------------------- persistence ------------------------------ */
  function autosave() {
    if (!game || game.won) return;
    store(LS.save, {
      dealNumber: game.dealNumber, numFree: game.numFree, tier: curTier,
      state: game.state, moveCount: game.moveCount, elapsedMs: elapsedMs(), ts: Date.now(),
    });
  }
  function load(key) { try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; } }
  function store(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) {} }

  /* ------------------------------- sheets -------------------------------- */
  function openSheet(html) { $('sheetBody').innerHTML = html; $('sheet').hidden = false; return $('sheetBody'); }
  function closeSheet() { $('sheet').hidden = true; }

  function openMenu() {
    const body = openSheet(
      '<h3>Vault controls</h3>' +
      '<div class="menu-btn-row">' +
      '<button id="mHint">Hint</button>' +
      '<button id="mAuto">Auto-solve</button>' +
      '<button id="mRestart">Restart deal</button>' +
      '<button id="mNew">New deal</button>' +
      '</div>' +
      '<div class="sheet-row"><div><div class="lbl">Sound</div><div class="sub">Synth SFX, works offline</div></div>' + toggleHtml('swSound', settings.sound) + '</div>' +
      '<div class="sheet-row"><div><div class="lbl">Haptics</div><div class="sub">Vibrate on invalid / win</div></div>' + toggleHtml('swHap', settings.haptics) + '</div>' +
      '<div class="sheet-row"><div><div class="lbl">Daytime bank (light)</div><div class="sub">Optional light theme</div></div>' + toggleHtml('swLight', settings.light) + '</div>' +
      '<div class="sheet-row"><div><div class="lbl">Statistics</div><div class="sub">Per vault tier</div></div><button class="ghost-btn" id="mStats">View</button></div>'
    );
    body.querySelector('#mHint').onclick = () => { closeSheet(); showHint(); };
    body.querySelector('#mAuto').onclick = () => autoSolve();
    body.querySelector('#mRestart').onclick = () => { closeSheet(); restartDeal(); };
    body.querySelector('#mNew').onclick = () => { closeSheet(); startNewGame(curTier); };
    body.querySelector('#mStats').onclick = () => openStats();
    wireToggle(body, 'swSound', (v) => { settings.sound = v; if (v) unlockAudio(); saveSettings(); });
    wireToggle(body, 'swHap', (v) => { settings.haptics = v; saveSettings(); });
    wireToggle(body, 'swLight', (v) => { settings.light = v; saveSettings(); });
  }

  function openSettings() {
    const body = openSheet(
      '<h3>Settings</h3>' +
      '<div class="sheet-row"><div><div class="lbl">Sound</div><div class="sub">Synthesized, works offline</div></div>' + toggleHtml('swSound', settings.sound) + '</div>' +
      '<div class="sheet-row"><div><div class="lbl">Haptics</div><div class="sub">Vibrate on invalid / win</div></div>' + toggleHtml('swHap', settings.haptics) + '</div>' +
      '<div class="sheet-row"><div><div class="lbl">Daytime bank (light theme)</div><div class="sub">The Vault is dark by default</div></div>' + toggleHtml('swLight', settings.light) + '</div>'
    );
    wireToggle(body, 'swSound', (v) => { settings.sound = v; if (v) unlockAudio(); saveSettings(); });
    wireToggle(body, 'swHap', (v) => { settings.haptics = v; saveSettings(); });
    wireToggle(body, 'swLight', (v) => { settings.light = v; saveSettings(); });
  }

  function openStats() {
    const s = getStats();
    let tab = curTier || 1;
    const draw = () => {
      const st = tierStat(s, tab);
      const rate = st.played ? Math.round((st.wins / st.played) * 100) : 0;
      const avg = st.wins ? fmt(st.totalWinMs / st.wins) : '—';
      const tabs = TIER_NAMES.map((nm, i) =>
        `<button class="${tab === i + 1 ? 'on' : ''}" data-t="${i + 1}">${nm.split(' ')[0]}</button>`).join('');
      openSheet(
        '<h3>Statistics — ' + TIER_NAMES[tab - 1] + '</h3>' +
        '<div class="stat-tabs">' + tabs + '</div>' +
        '<div class="stat-grid">' +
        cell('Played', st.played) + cell('Wins', st.wins) +
        cell('Win rate', rate + '%') + cell('Best time', st.bestMs ? fmt(st.bestMs) : '—') +
        cell('Avg win', avg) + cell('Streak', st.streak + ' / ' + st.bestStreak + ' best') +
        '</div>'
      );
      $('sheetBody').querySelectorAll('.stat-tabs button').forEach((b) =>
        b.onclick = () => { tab = +b.dataset.t; draw(); });
    };
    draw();
  }
  function cell(k, v) { return `<div><div class="k">${k}</div><div class="v">${v}</div></div>`; }
  function toggleHtml(id, on) { return `<div class="sw"><input type="checkbox" id="${id}" ${on ? 'checked' : ''}><label for="${id}"></label></div>`; }
  function wireToggle(root, id, cb) { const el = root.querySelector('#' + id); if (el) el.onchange = () => cb(el.checked); }

  function restartDeal() {
    if (!game) return;
    const dn = game.dealNumber;
    if (!game.won && game.moveCount > 0) breakStreak(curTier);
    game = new Game(dn, TIER_FREE_CELLS[curTier - 1]);
    sel = null; timer = { base: 0, startedAt: null, finalMs: null };
    stopWinFx(); render(); updateHud(); startTimer(); autosave();
  }

  /* -------------------------------- misc --------------------------------- */
  let toastT = null;
  function toast(msg) {
    const t = $('toast'); t.textContent = msg; t.hidden = false;
    if (toastT) clearTimeout(toastT);
    toastT = setTimeout(() => { t.hidden = true; }, 1600);
  }
  function fmt(ms) {
    const s = Math.floor(ms / 1000), m = Math.floor(s / 60), ss = s % 60;
    return m + ':' + (ss < 10 ? '0' : '') + ss;
  }
  function unlockAudio() { try { ac(); } catch (e) {} }

  function goHome() {
    pauseTimer(); autosave(); stopWinFx(); closeSheet();
    renderStart(); showScreen('start');
  }

  /* ------------------------------- wiring -------------------------------- */
  function wire() {
    $('backBtn').onclick = goHome;
    $('undoBtn').onclick = undo;
    $('menuBtn').onclick = openMenu;
    $('autoBtn').onclick = autoSafe;
    $('hintBtn').onclick = showHint;
    $('newDealBtn').onclick = () => startNewGame(curTier);
    $('restartBtn').onclick = restartDeal;
    $('statsBtn').onclick = openStats;
    $('settingsBtn').onclick = openSettings;
    $('sheetClose').onclick = closeSheet;
    $('sheet').addEventListener('click', (e) => { if (e.target === $('sheet')) closeSheet(); });
    $('wbContinue').onclick = () => { stopWinFx(); goHome(); };

    window.addEventListener('resize', () => { if (!$('gameScreen').hidden && game) { layout(); render(); } });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) pauseTimer();
      else if (!$('gameScreen').hidden && game && !game.won) startTimer();
    });
  }

  function init() {
    wire();
    renderStart();
    showScreen('start');
    if ('serviceWorker' in navigator && location.search.indexOf('debug') < 0) {
      window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
      // Auto-reload once when an updated service worker takes control, so a new
      // deploy reaches the player without a manual cache-clear (guarded against
      // the first-install claim and reload loops).
      let hadController = !!navigator.serviceWorker.controller;
      let refreshing = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!hadController) { hadController = true; return; }
        if (refreshing) return;
        refreshing = true;
        location.reload();
      });
    }
  }

  document.addEventListener('DOMContentLoaded', init);

  // Debug hook (enabled with ?debug) for headless playtesting — not used in play.
  if (location.search.indexOf('debug') >= 0) {
    window.__V = {
      get game() { return game; }, get sel() { return sel; }, get busy() { return busy; },
      state: () => game && game.state,
      tapCard: onCardTap, tapCol: onColumnTap, tapFree: onFreeTap, tapFound: onFoundationTap, dbl: onCardDouble,
      start: startNewGame, undo, autoSafe, autoSolve, elapsedMs, getStats,
      cardAt: (col, depth) => game.state.cols[col][depth],
      render, layout, rebuild: buildBoardDom,
      setState: (st) => { game.state = st; buildBoardDom(); layout(); render(); },
      colzone: (c) => geom.colzones[c],
    };
  }
})();
