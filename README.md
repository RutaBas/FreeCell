# FreeCell · The Vault

A mobile-first, installable (PWA) FreeCell solitaire game. Vanilla HTML/CSS/JS,
no framework, no build step, no backend — everything runs client-side and works
offline. Themed as cracking a bank vault after hours: free cells are
safe-deposit boxes, foundations are the vaults you fill by suit.

## Run it

```
node tools/serve.js 8123      # tiny static server
# open http://localhost:8123
```
Any static host works (it's just files). For local dev with live edits, append
`?debug` to the URL — that skips the service worker (so you always get fresh
files) and exposes a `window.__V` test hook.

## Files

| File | Role |
|------|------|
| `index.html` | App shell: start screen, game screen, overlays |
| `style.css` | The Vault visual language (felt/brass/cream, spacing scale, motion) |
| `game.js` | **Pure model & rules** — card encoding, Microsoft deal RNG, legality, supermove limit, `Game` controller. No DOM; runs under node. |
| `solver.js` | **State-space solver** — weighted best-first with canonical-hash dedup + safe auto-moves; solvability, winning move-path, difficulty grading, and the deal generator. |
| `deals.js` | Solver-graded deal pool (100 numbers per tier), auto-generated. |
| `app.js` | UI: rendering, tap-to-move, sound, timer, persistence, stats, hints/auto-solve, win cascade, PWA registration. |
| `manifest.json`, `sw.js`, `icons/` | PWA: installability + offline app-shell cache. |
| `tests/` | Node verification tests. |
| `tools/` | Calibration, pool builder, icon maker, static server (dev only). |

## Solver-first architecture

`solver.js` was written before the generator, and the generator before the UI.

- **Solvability + hints + auto-solve** all come from one search: weighted A*
  (`f = g + W·h`), a visited-set keyed by a **canonical** state hash (free cells
  and columns are interchangeable, so they're sorted before hashing — this
  collapses symmetric states and lets hard/unsolvable deals be exhausted), safe
  foundation auto-moves collapsed into every transition, and a hard node cap so
  it always terminates. **Exhausting the frontier is a proof of unsolvability.**
- **Reproducible deals**: the classic Windows FreeCell LCG (`seed*214013+2531011`,
  `(seed>>16)&0x7fff`) reproduces any deal by number — this is what makes the
  solver testable against known deals.
- **Every shown deal is solver-verified.** Deals ship as a pre-graded pool
  (`deals.js`) built by `tools/build-pool.js`, which scans reproducible deal
  numbers, grades each with the solver, and only keeps solvable ones in the
  right tier. No unsolvable board can ever appear.

### Difficulty = solver effort, not blank space

Each solvable deal is graded at its tier's free-cell count from three solver
signals — solution length, states expanded, and accumulated branching pressure
(non-forced choices) — combined into a score, calibrated on 400 deals into five
bands (empirical quintiles ≈ 127 / 137 / 146 / 156):

1. **Petty Cash** · 2. **Safe Deposit** · 3. **Vault** · 4. **Gold Reserve** — 4 free cells, rising graded hardness.
5. **Fort Knox** — the hardest band **and** only **3 free cells**; every Fort Knox deal is verified solvable at 3 cells.

## Verification (all passing)

```
node tests/test-core.js            # VP1, VP2, VP3, VP5
node tests/test-generator.js 25    # VP4 on a 25/tier sample (use no arg for full 100/tier)
```

- **VP1 — supermove limit.** 2 free + 1 empty col → 6 to a filled column, but 3
  into that empty column. Asserted (plus more cases).
- **VP2 — known deals.** Deal #1 is solvable (and its returned path is replayed
  to a win); the classic impossible **#11982** is reported unsolvable by frontier
  exhaustion (~62k states, <1s).
- **VP3 — move legality.** Foundation accepts only an Ace on empty or exact
  rank+1 same-suit; tableau only opposite-color, one rank lower. Positive +
  negative cases.
- **VP4 — generator guarantee.** Across the shipped pool: 0 unsolvable, every
  deal in its tier's band, every Fort Knox deal solvable with 3 free cells.
- **VP5 — win fires once.** The final King to foundation latches the win exactly
  once and not before.

## Notes on decisions made during the build

- **Precomputed deal pool instead of live generation.** Grading is ~0.4 s/deal,
  too slow to do live per new game. Since deal numbers are reproducible and every
  deal must be solver-verified anyway, the generator runs offline and bakes a
  100-per-tier verified pool into `deals.js`; the app picks from it instantly.
  (The live `generateDeal()` still exists — it's what builds the pool.)
- **Icons & emblem** were generated from `vault.png` with an in-browser canvas
  (`tools/make-icons.html`) since no image tool was available: 180/192/512 app
  icons on the felt background, plus a lightweight transparent `vault-emblem.png`
  for the start screen (the original 4 MB `vault.png` is kept only as the icon
  source, not shipped in the offline cache).
- Deal #1, by this difficulty metric, grades into **Fort Knox** — it's a
  genuinely branch-heavy board.

## Install on iPhone (Safari)

1. Deploy the folder to any static host (e.g. Netlify — drag the folder in, or
   push to a linked GitHub repo).
2. Open the site URL in **Safari** on the iPhone (not Chrome).
3. Tap **Share → Add to Home Screen**.
4. It launches full-screen, offline-capable, with the vault icon.

Bump `CACHE_NAME` in `sw.js` on every deploy or the service worker keeps serving
the old cached version.
