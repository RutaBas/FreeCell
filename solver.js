/* ============================================================================
 * solver.js — FreeCell "The Vault"
 * State-space search that (a) decides solvability + returns a winning move-path,
 * (b) powers hints/auto-solve, (c) grades deal difficulty for the generator.
 *
 * Strategy: weighted best-first (A* with a fast heuristic), a visited-set keyed
 * by the canonical state hash, safe foundation auto-moves collapsed into each
 * transition, deterministic move ordering, and a hard node cap so it always
 * terminates. Exhausting the frontier (queue empty before the cap) is a proof
 * of unsolvability.
 * ========================================================================== */

if (typeof module !== 'undefined' && module.exports) {
  // Node: pull game.js globals into scope without redeclaring (browser has them
  // ambient from the earlier <script> tag).
  Object.assign(global, require('./game.js'));
}

/* ---- Binary min-heap keyed by numeric priority ---------------------------- */
class MinHeap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(item) {
    const a = this.a; a.push(item); let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].f <= a[i].f) break;
      [a[p], a[i]] = [a[i], a[p]]; i = p;
    }
  }
  pop() {
    const a = this.a; const top = a[0]; const last = a.pop();
    if (a.length) { a[0] = last; let i = 0; const n = a.length;
      for (;;) {
        let l = 2 * i + 1, r = l + 1, m = i;
        if (l < n && a[l].f < a[m].f) m = l;
        if (r < n && a[r].f < a[m].f) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]]; i = m;
      }
    }
    return top;
  }
}

/* ---- Heuristic: rough estimate of moves remaining ------------------------- */
function heuristic(s) {
  let h = 52 - (s.found[0] + s.found[1] + s.found[2] + s.found[3]);
  // penalize disorder: cards buried above the next card each foundation needs
  for (let suit = 0; suit < 4; suit++) {
    const need = s.found[suit] + 1;
    if (need > 13) continue;
    const target = ((need - 1) << 2) | suit; // card int for that suit+rank
    for (const col of s.cols) {
      const idx = col.indexOf(target);
      if (idx >= 0) { h += (col.length - 1 - idx); break; }
    }
  }
  // cards parked in free cells still have to come home
  for (const c of s.free) if (c != null) h += 1;
  return h;
}

/* ---- Apply the safe-automove chain, returning the extra moves it played ---- */
function drainSafe(s) {
  const played = [];
  let m;
  while ((m = safeAutoMove(s))) { applyMove(s, m); played.push(m); }
  return played;
}

/* ---- Core search ---------------------------------------------------------- */
// opts: { maxNodes, weight, wantPath }
function solve(state0, opts) {
  opts = opts || {};
  const maxNodes = opts.maxNodes || 200000;
  const W = opts.weight || 2;          // weight on heuristic (>1 = faster, less optimal)
  const wantPath = opts.wantPath !== false;

  const start = cloneState(state0);
  const startAuto = drainSafe(start);

  const visited = new Set();
  const heap = new MinHeap();
  let counter = 0;

  heap.push({ state: start, g: startAuto.length, f: 0, path: wantPath ? startAuto.slice() : null, seq: counter++ });

  let nodes = 0;
  let branchPoints = 0;   // states where >1 non-forced move existed
  let choiceSum = 0;      // total non-forced options seen (branching pressure)
  let exhausted = true;
  let maxFreeUsed = 0;

  while (heap.size) {
    if (nodes >= maxNodes) { exhausted = false; break; }
    const node = heap.pop();
    const key = stateKey(node.state);
    if (visited.has(key)) continue;
    visited.add(key);
    nodes++;

    const st = node.state;
    if (isWin(st)) {
      return {
        solvable: true, exhausted: false, nodes,
        length: node.path ? node.path.length : node.g,
        path: node.path || [],
        branchPoints, choiceSum,
      };
    }

    const usedFree = st.numFree - countEmptyFree(st);
    if (usedFree > maxFreeUsed) maxFreeUsed = usedFree;

    const moves = genMoves(st);
    if (moves.length > 1) { branchPoints++; choiceSum += (moves.length - 1); }

    for (const m of moves) {
      const child = cloneState(st);
      applyMove(child, m);
      const auto = drainSafe(child);
      const ckey = stateKey(child);
      if (visited.has(ckey)) continue;
      const g = node.g + 1 + auto.length;
      const h = heuristic(child);
      let path = null;
      if (wantPath) { path = node.path.slice(); path.push(m); for (const a of auto) path.push(a); }
      heap.push({ state: child, g, f: g + W * h, path, seq: counter++ });
    }
  }

  return { solvable: false, exhausted, nodes, branchPoints, choiceSum, maxFreeUsed };
}

/* Convenience: solve a deal number directly. */
function solveDeal(dealNumber, numFree, opts) {
  return solve(newState(dealNumber, numFree || 4), opts);
}

/* ---------------------------------------------------------------------------
 * Difficulty grading.
 * Raw signals from a bounded weighted-A* run at the tier's free-cell count:
 *   length      — solution length (proxy for depth of plan)
 *   nodes       — states expanded to reach it (exploration effort)
 *   choiceSum   — accumulated non-forced options (branching pressure)
 * Combined into a single score, then bucketed. Thresholds are calibrated
 * empirically (see tools/calibrate.js) so each of the 5 tiers is populated.
 * ------------------------------------------------------------------------- */
const GRADE_OPTS = { maxNodes: 250000, weight: 3, wantPath: false };

function difficultyScore(res) {
  // res is a solvable solve() result
  const lenTerm = res.length;
  const nodeTerm = Math.log2(Math.max(2, res.nodes));
  const pressTerm = Math.log2(1 + res.choiceSum);
  return res.length * 0.6 + nodeTerm * 4.0 + pressTerm * 2.5;
}

// Score bands (calibrated). Index 0..4 => tiers 1..5.
// Tiers 1-4 graded at 4 free cells; Fort Knox (tier 5) is the hardest band AND
// must also be solvable at 3 free cells.
// Calibrated on 400 deals (W=3 grading): score spans ~101..182, quintile cuts
// 127 / 137 / 146 / 156. Each band holds ~1/5 of solvable deals.
const TIER_BANDS = [
  { max: 127 },         // 1 Petty Cash
  { max: 137 },         // 2 Safe Deposit
  { max: 146 },         // 3 Vault
  { max: 156 },         // 4 Gold Reserve
  { max: Infinity },    // 5 Fort Knox
];

function scoreToTier(score) {
  for (let i = 0; i < TIER_BANDS.length; i++) if (score <= TIER_BANDS[i].max) return i + 1;
  return 5;
}

// Grade a deal at 4 free cells. Returns { solvable, score, tier, metrics }.
function gradeDeal(dealNumber) {
  const res = solve(newState(dealNumber, 4), GRADE_OPTS);
  if (!res.solvable) return { solvable: false };
  const score = difficultyScore(res);
  return {
    solvable: true,
    score,
    tier: scoreToTier(score),
    metrics: { length: res.length, nodes: res.nodes, choiceSum: res.choiceSum },
  };
}

/* ---------------------------------------------------------------------------
 * Generator: solver-validated, difficulty-bucketed deals.
 * Every returned deal is proven solvable (path found) at the right free-cell
 * count, and its graded score falls in the requested tier's band.
 * ------------------------------------------------------------------------- */
const TIER_NAMES = ['Petty Cash', 'Safe Deposit', 'Vault', 'Gold Reserve', 'Fort Knox'];
const TIER_FREE_CELLS = [4, 4, 4, 4, 3];

// Deterministic-ish source of candidate deal numbers from a seed, so a given
// (tier, seed) reproduces. Uses a small LCG over the 32-bit deal-number space
// Windows FreeCell supports (1 .. 1,000,000 is plenty and well-studied).
function candidateStream(seed) {
  let x = (seed | 0) || 1;
  return function next() {
    x = (Math.imul(x, 1103515245) + 12345) | 0;
    return 1 + (Math.abs(x) % 1000000);
  };
}

// Find a deal number for `tier` (1..5). `seed` makes the search reproducible.
// Returns { dealNumber, tier, numFree, score } or null if none found in budget.
function generateDeal(tier, seed, maxTries) {
  maxTries = maxTries || 4000;
  const next = candidateStream(seed || (Date.now() & 0x7fffffff));
  const numFree = TIER_FREE_CELLS[tier - 1];
  for (let t = 0; t < maxTries; t++) {
    const dn = next();
    const g = gradeDeal(dn);
    if (!g.solvable) continue;
    if (g.tier !== tier) continue;
    if (tier === 5) {
      // Fort Knox: must also be solvable with only 3 free cells.
      const r3 = solve(newState(dn, 3), { maxNodes: 200000, weight: 2, wantPath: false });
      if (!r3.solvable) continue;
    }
    return { dealNumber: dn, tier, numFree, score: g.score };
  }
  return null;
}

/* --------------------------------------------------------------------------- */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    MinHeap, heuristic, solve, solveDeal,
    difficultyScore, scoreToTier, gradeDeal, TIER_BANDS,
    generateDeal, TIER_NAMES, TIER_FREE_CELLS, candidateStream, GRADE_OPTS,
  };
}
