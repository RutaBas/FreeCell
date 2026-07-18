/* ============================================================================
 * game.js — FreeCell "The Vault"
 * Pure game model + rules. No DOM. Runs in the browser (as a plain <script>,
 * sharing global scope with solver.js/app.js) AND under node for tests.
 *
 * Card encoding (matches the Microsoft FreeCell deal numbering):
 *   card is an int 0..51
 *   suit = card & 3        0=Clubs 1=Diamonds 2=Hearts 3=Spades
 *   rank = (card >> 2) + 1  1=Ace .. 13=King
 *   red  = suit is Diamonds(1) or Hearts(2)
 * ========================================================================== */

const RANK_LABEL = ['', 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const SUIT_GLYPH = ['♣', '♦', '♥', '♠']; // ♣ ♦ ♥ ♠
const SUIT_LETTER = ['C', 'D', 'H', 'S'];

function suitOf(c) { return c & 3; }
function rankOf(c) { return (c >> 2) + 1; }
function isRed(c) { const s = c & 3; return s === 1 || s === 2; }
function colorOf(c) { return isRed(c) ? 1 : 0; }
function cardLabel(c) { return RANK_LABEL[rankOf(c)] + SUIT_GLYPH[suitOf(c)]; }

/* ---------------------------------------------------------------------------
 * Microsoft deal RNG (Windows FreeCell LCG). Reproducible deals by number.
 * rand() = (seed = seed*214013 + 2531011) ; return (seed >> 16) & 0x7fff
 * Uses Math.imul + |0 to emulate C 32-bit signed int overflow exactly.
 * ------------------------------------------------------------------------- */
function msDeal(seed) {
  let state = seed | 0;
  function rnd() {
    state = (Math.imul(state, 214013) + 2531011) | 0;
    return (state >>> 16) & 0x7fff;
  }
  const deck = [];
  for (let i = 0; i < 52; i++) deck.push(i);
  const cols = [[], [], [], [], [], [], [], []];
  let n = 52;
  for (let i = 0; i < 52; i++) {
    const j = rnd() % n;
    const card = deck[j];
    deck[j] = deck[n - 1];
    n--;
    cols[i % 8].push(card);
  }
  return cols;
}

/* ---------------------------------------------------------------------------
 * State shape (plain object, cheap to clone):
 *   { cols:  [ [card,...] x8 ],   bottom..top
 *     free:  [ card|null x numFree ],
 *     found: [ rankReached x4 ],  index by suit, 0=empty .. 13=King done
 *     numFree }
 * ------------------------------------------------------------------------- */
function newState(dealNumber, numFree) {
  numFree = numFree || 4;
  const cols = msDeal(dealNumber);
  return {
    cols: cols.map((c) => c.slice()),
    free: new Array(numFree).fill(null),
    found: [0, 0, 0, 0],
    numFree,
  };
}

function cloneState(s) {
  return {
    cols: s.cols.map((c) => c.slice()),
    free: s.free.slice(),
    found: s.found.slice(),
    numFree: s.numFree,
  };
}

/* Canonical key: free cells and columns are interchangeable, so sort them.
 * This collapses symmetric states and makes the visited-set effective enough
 * to exhaust hard/unsolvable deals. */
function stateKey(s) {
  const f = s.free.filter((x) => x != null).sort((a, b) => a - b).join(',');
  const cols = s.cols.map((c) => c.join(',')).sort();
  return f + '|' + s.found.join(',') + '|' + cols.join(';');
}

function isWin(s) {
  return s.found[0] === 13 && s.found[1] === 13 && s.found[2] === 13 && s.found[3] === 13;
}

/* ---------------------------------------------------------------------------
 * Legality primitives
 * ------------------------------------------------------------------------- */
// A card may sit on a tableau card if opposite color and exactly one rank lower.
function canStack(card, onto) {
  return colorOf(card) !== colorOf(onto) && rankOf(card) === rankOf(onto) - 1;
}
// A card may go to its foundation if it's the next rank up for its suit.
function canToFoundation(card, found) {
  return rankOf(card) === found[suitOf(card)] + 1;
}

// Longest descending, alternating-color run sitting at the TOP of a column.
// Returns the count of cards forming that ordered run (>=1 if column nonempty).
function topRunLength(col) {
  if (col.length === 0) return 0;
  let n = 1;
  for (let i = col.length - 1; i > 0; i--) {
    if (canStack(col[i], col[i - 1])) n++;
    else break;
  }
  return n;
}

function countEmptyFree(s) { let n = 0; for (const c of s.free) if (c == null) n++; return n; }
function countEmptyCols(s) { let n = 0; for (const c of s.cols) if (c.length === 0) n++; return n; }

// Max cards movable as one supermove.
//   (1 + freeEmpty) * 2^(emptyCols)
// If the destination is an empty column, it doesn't count toward emptyCols.
function maxSupermove(freeEmpty, emptyCols, toEmpty) {
  const e = toEmpty ? Math.max(0, emptyCols - 1) : emptyCols;
  return (1 + freeEmpty) * Math.pow(2, e);
}

/* ---------------------------------------------------------------------------
 * Move representation (used by BOTH solver and UI):
 *   { fromType, fromIdx, toType, toIdx, n, cards }
 *   type is 'col' | 'free' | 'found'.  n = number of cards moved.
 *   `cards` (top..bottom order not required) is filled in for animation/undo.
 * ------------------------------------------------------------------------- */
function applyMove(s, m) {
  let moving;
  if (m.fromType === 'col') {
    const col = s.cols[m.fromIdx];
    moving = col.splice(col.length - m.n, m.n); // bottom..top order preserved
  } else { // free
    moving = [s.free[m.fromIdx]];
    s.free[m.fromIdx] = null;
  }
  if (m.toType === 'col') {
    for (const c of moving) s.cols[m.toIdx].push(c);
  } else if (m.toType === 'free') {
    s.free[m.toIdx] = moving[0];
  } else { // found
    s.found[suitOf(moving[0])]++;
  }
  return s;
}

/* ---------------------------------------------------------------------------
 * Move generation for the solver.
 * Prefers forced foundation moves; keeps branching bounded by generating at
 * most one tableau-to-tableau move per (source,dest) pair.
 * ------------------------------------------------------------------------- */
function genMoves(s) {
  const moves = [];
  const freeEmpty = countEmptyFree(s);
  const emptyCols = countEmptyCols(s);

  // 1) To foundation (from column tops and free cells)
  for (let i = 0; i < s.cols.length; i++) {
    const col = s.cols[i];
    if (col.length && canToFoundation(col[col.length - 1], s.found)) {
      moves.push({ fromType: 'col', fromIdx: i, toType: 'found', toIdx: suitOf(col[col.length - 1]), n: 1 });
    }
  }
  for (let i = 0; i < s.free.length; i++) {
    const c = s.free[i];
    if (c != null && canToFoundation(c, s.found)) {
      moves.push({ fromType: 'free', fromIdx: i, toType: 'found', toIdx: suitOf(c), n: 1 });
    }
  }

  // 2) Tableau-to-tableau (supermoves). One move per (src,dst) pair.
  for (let i = 0; i < s.cols.length; i++) {
    const src = s.cols[i];
    if (src.length === 0) continue;
    const run = topRunLength(src);
    for (let j = 0; j < s.cols.length; j++) {
      if (i === j) continue;
      const dst = s.cols[j];
      if (dst.length === 0) {
        // Move to empty column: allow the whole movable run (capped), and a single card.
        const cap = Math.min(run, maxSupermove(freeEmpty, emptyCols, true));
        if (cap >= 1) {
          // Avoid the pointless "empty a column just to fill another empty" churn:
          // only move onto empty if it actually relocates a multi-card run or frees the source.
          moves.push({ fromType: 'col', fromIdx: i, toType: 'col', toIdx: j, n: Math.max(1, cap) });
          if (cap > 1) moves.push({ fromType: 'col', fromIdx: i, toType: 'col', toIdx: j, n: 1 });
        }
      } else {
        const topDst = dst[dst.length - 1];
        // Find, within the top run, the card that would land legally on topDst.
        // Its rank must be rankOf(topDst)-1 and opposite color; the moved count is
        // its depth from the top.
        const needRank = rankOf(topDst) - 1;
        if (needRank >= 1) {
          for (let k = 1; k <= run; k++) {
            const card = src[src.length - k]; // k cards from top
            if (rankOf(card) === needRank && colorOf(card) !== colorOf(topDst)) {
              if (k <= maxSupermove(freeEmpty, emptyCols, false)) {
                moves.push({ fromType: 'col', fromIdx: i, toType: 'col', toIdx: j, n: k });
              }
              break; // ranks are unique within a valid run
            }
          }
        }
      }
    }
  }

  // 3) Column top -> empty free cell (only need one free-cell target)
  let freeSlot = -1;
  for (let i = 0; i < s.free.length; i++) if (s.free[i] == null) { freeSlot = i; break; }
  if (freeSlot >= 0) {
    for (let i = 0; i < s.cols.length; i++) {
      if (s.cols[i].length) {
        moves.push({ fromType: 'col', fromIdx: i, toType: 'free', toIdx: freeSlot, n: 1 });
      }
    }
  }

  // 4) Free cell -> tableau
  for (let i = 0; i < s.free.length; i++) {
    const c = s.free[i];
    if (c == null) continue;
    for (let j = 0; j < s.cols.length; j++) {
      const dst = s.cols[j];
      if (dst.length === 0) {
        moves.push({ fromType: 'free', fromIdx: i, toType: 'col', toIdx: j, n: 1 });
      } else if (canStack(c, dst[dst.length - 1])) {
        moves.push({ fromType: 'free', fromIdx: i, toType: 'col', toIdx: j, n: 1 });
      }
    }
  }

  return moves;
}

/* Safe auto-play: a card can always be sent to its foundation without ever
 * being needed to host a lower opposite-color card once BOTH opposite-color
 * foundations have reached rank-1 (and same-color other suit reached rank-2,
 * per the standard safe rule). Returns a single such move or null. */
function safeAutoMove(s) {
  const tryCard = (card, fromType, fromIdx) => {
    if (card == null) return null;
    const r = rankOf(card), su = suitOf(card);
    if (r !== s.found[su] + 1) return null;
    if (r <= 2) return { fromType, fromIdx, toType: 'found', toIdx: su, n: 1 }; // aces & twos always safe
    // opposite-color foundations
    let opp1, opp2, sameOther;
    if (isRed(card)) { opp1 = 0; opp2 = 3; sameOther = (su === 1) ? 2 : 1; }
    else { opp1 = 1; opp2 = 2; sameOther = (su === 3) ? 0 : 3; }
    if (s.found[opp1] >= r - 1 && s.found[opp2] >= r - 1) {
      return { fromType, fromIdx, toType: 'found', toIdx: su, n: 1 };
    }
    return null;
  };
  for (let i = 0; i < s.cols.length; i++) {
    const col = s.cols[i];
    if (col.length) { const m = tryCard(col[col.length - 1], 'col', i); if (m) return m; }
  }
  for (let i = 0; i < s.free.length; i++) {
    const m = tryCard(s.free[i], 'free', i); if (m) return m;
  }
  return null;
}

/* ---------------------------------------------------------------------------
 * Game controller for the UI: holds state, move history (undo), and exposes
 * higher-level operations. Rendering lives entirely in app.js.
 * ------------------------------------------------------------------------- */
class Game {
  constructor(dealNumber, numFree) {
    this.dealNumber = dealNumber;
    this.numFree = numFree || 4;
    this.state = newState(dealNumber, this.numFree);
    this.history = []; // stack of moves for undo
    this.moveCount = 0;
    this.won = false;
  }

  snapshot() {
    return {
      dealNumber: this.dealNumber,
      numFree: this.numFree,
      state: cloneState(this.state),
      moveCount: this.moveCount,
      won: this.won,
    };
  }

  static fromSnapshot(snap) {
    const g = Object.create(Game.prototype);
    g.dealNumber = snap.dealNumber;
    g.numFree = snap.numFree;
    g.state = snap.state;
    g.history = [];
    g.moveCount = snap.moveCount || 0;
    g.won = !!snap.won;
    return g;
  }

  // Validate + apply a move. Returns true if applied. Records undo history.
  doMove(m) {
    if (!this._legal(m)) return false;
    this.history.push({ move: m, prev: cloneState(this.state) });
    applyMove(this.state, m);
    this.moveCount++;
    if (isWin(this.state)) this.won = true;
    return true;
  }

  undo() {
    const h = this.history.pop();
    if (!h) return false;
    this.state = h.prev;
    this.moveCount++; // undo counts as a move played (matches most FreeCell UIs)
    this.won = false;
    return true;
  }

  canUndo() { return this.history.length > 0; }

  _legal(m) {
    const s = this.state;
    if (m.fromType === 'col') {
      const col = s.cols[m.fromIdx];
      if (m.n < 1 || m.n > col.length) return false;
      // the moving cards must themselves form a valid ordered run
      for (let k = 0; k < m.n - 1; k++) {
        const lower = col[col.length - 1 - k];
        const upper = col[col.length - 2 - k];
        if (!canStack(lower, upper)) return false;
      }
    } else if (m.fromType === 'free') {
      if (s.free[m.fromIdx] == null || m.n !== 1) return false;
    } else return false;

    const moving = m.fromType === 'col'
      ? s.cols[m.fromIdx].slice(s.cols[m.fromIdx].length - m.n)
      : [s.free[m.fromIdx]];
    const bottom = moving[0];

    if (m.toType === 'found') {
      return m.n === 1 && canToFoundation(bottom, s.found) && suitOf(bottom) === m.toIdx;
    }
    if (m.toType === 'free') {
      return m.n === 1 && s.free[m.toIdx] == null;
    }
    if (m.toType === 'col') {
      const dst = s.cols[m.toIdx];
      const freeEmpty = countEmptyFree(s);
      // an empty source column shouldn't count as an empty column for its own move
      let emptyCols = countEmptyCols(s);
      const toEmpty = dst.length === 0;
      if (m.fromType === 'col' && s.cols[m.fromIdx].length === m.n) {
        // source becomes empty; but it's the origin, still counts normally for capacity
      }
      const cap = maxSupermove(freeEmpty, emptyCols, toEmpty);
      if (m.n > cap) return false;
      if (toEmpty) return true;
      return canStack(bottom, dst[dst.length - 1]);
    }
    return false;
  }
}

/* --------------------------------------------------------------------------- */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    RANK_LABEL, SUIT_GLYPH, SUIT_LETTER,
    suitOf, rankOf, isRed, colorOf, cardLabel,
    msDeal, newState, cloneState, stateKey, isWin,
    canStack, canToFoundation, topRunLength,
    countEmptyFree, countEmptyCols, maxSupermove,
    applyMove, genMoves, safeAutoMove, Game,
  };
}
