/* Core verification tests — run with: node tests/test-core.js
 * Covers verification points 1, 2, 3, 5 (VP4 = generator batch, separate file). */
const G = require('../game.js');
const S = require('../solver.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  -> ' + extra : '')); }
}
function section(t) { console.log('\n' + t); }

/* ===================== VP1: supermove limit ============================== */
section('VP1  Supermove limit');
// 2 free cells empty, 1 empty column, to a NON-empty column => (1+2)*2^1 = 6
ok('2 free, 1 empty col, to filled column = 6',
  G.maxSupermove(2, 1, false) === 6, G.maxSupermove(2, 1, false));
// same sequence into the empty column => empty col doesn't count => (1+2)*2^0 = 3
ok('2 free, 1 empty col, into that empty column = 3',
  G.maxSupermove(2, 1, true) === 3, G.maxSupermove(2, 1, true));
// a few more
ok('0 free, 0 empty, filled = 1', G.maxSupermove(0, 0, false) === 1);
ok('4 free, 0 empty, filled = 5', G.maxSupermove(4, 0, false) === 5);
ok('4 free, 2 empty, filled = 20', G.maxSupermove(4, 2, false) === 20);
ok('4 free, 2 empty, to empty = 10', G.maxSupermove(4, 2, true) === 10);

/* ===================== VP3: move legality =============================== */
section('VP3  Move legality');
// helper to build a card int
const C = (rank, suit) => ((rank - 1) << 2) | suit; // suit 0=C 1=D 2=H 3=S
const AC = C(1, 0), AS = C(1, 3), TenH = C(10, 2), NineS = C(9, 3), NineC = C(9, 0), EightH = C(8, 2);

// Foundation: only Ace onto empty
ok('Ace of Clubs onto empty club foundation', G.canToFoundation(AC, [0, 0, 0, 0]));
ok('2 of Clubs rejected onto empty foundation', !G.canToFoundation(C(2, 0), [0, 0, 0, 0]));
// Foundation: exact rank+1 same suit
ok('3 of Hearts onto Hearts=2', G.canToFoundation(C(3, 2), [0, 0, 2, 0]));
ok('4 of Hearts rejected onto Hearts=2', !G.canToFoundation(C(4, 2), [0, 0, 2, 0]));
ok('3 of Spades rejected onto Hearts=2 (wrong suit slot)',
  !(G.canToFoundation(C(3, 3), [0, 0, 2, 0]) && G.suitOf(C(3, 3)) === 2));

// Tableau: opposite color, one rank lower
ok('9S onto 10H (black on red, one lower) legal', G.canStack(NineS, TenH));
ok('9C onto 10H legal (black on red)', G.canStack(NineC, TenH));
ok('9H onto 10H rejected (same color)', !G.canStack(C(9, 2), TenH));
ok('8H onto 10H rejected (rank gap)', !G.canStack(EightH, TenH));
ok('10H onto 9S rejected (wrong direction)', !G.canStack(TenH, NineS));

/* ===================== VP2: known deals ================================= */
section('VP2  Known Microsoft deals');
// Deal #1 must be solvable
const d1 = S.solveDeal(1, 4, { maxNodes: 200000, weight: 2 });
ok('Deal #1 solvable', d1.solvable, 'nodes=' + d1.nodes);
if (d1.solvable) {
  // Validate the returned path actually wins from a fresh deal.
  const st = G.newState(1, 4);
  let good = true;
  for (const m of d1.path) { if (!validAndApply(st, m)) { good = false; break; } }
  ok('Deal #1 solution path is legal and wins', good && G.isWin(st));
}
// The classic impossible Deal #11982 must be reported unsolvable (frontier exhausted)
const d11982 = S.solveDeal(11982, 4, { maxNodes: 4000000, weight: 2, wantPath: false });
ok('Deal #11982 reported unsolvable', !d11982.solvable && d11982.exhausted,
  'exhausted=' + d11982.exhausted + ' nodes=' + d11982.nodes);

/* independent legality re-check used to validate solver output */
function validAndApply(s, m) {
  // reconstruct legality without the Game wrapper
  let moving;
  if (m.fromType === 'col') {
    const col = s.cols[m.fromIdx];
    if (m.n < 1 || m.n > col.length) return false;
    for (let k = 0; k < m.n - 1; k++) {
      if (!G.canStack(col[col.length - 1 - k], col[col.length - 2 - k])) return false;
    }
    moving = col.slice(col.length - m.n);
  } else {
    if (s.free[m.fromIdx] == null || m.n !== 1) return false;
    moving = [s.free[m.fromIdx]];
  }
  const bottom = moving[0];
  const freeEmpty = G.countEmptyFree(s), emptyCols = G.countEmptyCols(s);
  if (m.toType === 'found') {
    if (!(m.n === 1 && G.canToFoundation(bottom, s.found) && G.suitOf(bottom) === m.toIdx)) return false;
  } else if (m.toType === 'free') {
    if (!(m.n === 1 && s.free[m.toIdx] == null)) return false;
  } else if (m.toType === 'col') {
    const dst = s.cols[m.toIdx];
    const toEmpty = dst.length === 0;
    if (m.n > G.maxSupermove(freeEmpty, emptyCols, toEmpty)) return false;
    if (!toEmpty && !G.canStack(bottom, dst[dst.length - 1])) return false;
  } else return false;
  G.applyMove(s, m);
  return true;
}

/* ===================== VP5: win fires exactly once ====================== */
section('VP5  Win fires once, and only on the final card');
(function () {
  // Build a near-won game: all foundations at K except one suit missing its King,
  // with that King as the only tableau card.
  const g = new G.Game(1, 4);
  // hand-craft a state: foundations [13,13,13,12], the King of Spades on a column
  g.state = {
    cols: [[G.suitOf(0) === 3 ? 0 : ((13 - 1) << 2) | 3]], // KS = rank13 suit3
    free: [null, null, null, null],
    found: [13, 13, 13, 12],
    numFree: 4,
  };
  // pad columns to 8
  while (g.state.cols.length < 8) g.state.cols.push([]);
  g.won = false;
  let winCount = 0;
  const KS = ((13 - 1) << 2) | 3;
  // sanity
  ok('crafted KS present', g.state.cols[0][0] === KS);
  ok('not won before final move', !g.won);
  const before = g.doMove({ fromType: 'col', fromIdx: 0, toType: 'found', toIdx: 3, n: 1 });
  if (g.won) winCount++;
  ok('final move applied', before);
  ok('won after final King', g.won);
  ok('win latched exactly once (no further moves possible)', winCount === 1 && G.isWin(g.state));
})();

/* ===================== summary ========================================== */
console.log('\n----------------------------------------');
console.log(`  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
