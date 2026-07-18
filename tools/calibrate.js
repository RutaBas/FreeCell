/* Sweep many deals, grade them, and report the score distribution so the
 * TIER_BANDS thresholds can be set to populate all 5 tiers.
 * Usage: node tools/calibrate.js [count]  */
const G = require('../game.js');
const S = require('../solver.js');

const N = parseInt(process.argv[2] || '400', 10);
const scores = [];
let unsolved = 0, capped = 0;
const t0 = Date.now();

for (let dn = 1; dn <= N; dn++) {
  const res = S.solve(G.newState(dn, 4), S.GRADE_OPTS);
  if (!res.solvable) {
    if (res.exhausted) unsolved++; else capped++;
    continue;
  }
  scores.push({ dn, score: S.difficultyScore(res), len: res.length, nodes: res.nodes, choice: res.choiceSum });
}

scores.sort((a, b) => a.score - b.score);
const q = (p) => scores[Math.min(scores.length - 1, Math.floor(p * scores.length))].score;
console.log(`Graded ${scores.length}/${N} deals in ${((Date.now() - t0) / 1000).toFixed(1)}s  (unsolved-exhausted=${unsolved}, capped=${capped})`);
console.log('score  min=%s  p20=%s  p40=%s  p60=%s  p80=%s  p95=%s  max=%s',
  scores[0].score.toFixed(1), q(0.2).toFixed(1), q(0.4).toFixed(1), q(0.6).toFixed(1),
  q(0.8).toFixed(1), q(0.95).toFixed(1), scores[scores.length - 1].score.toFixed(1));

// suggested even-quintile cut points
console.log('quintile cuts (p20/p40/p60/p80): %s / %s / %s / %s',
  q(0.2).toFixed(1), q(0.4).toFixed(1), q(0.6).toFixed(1), q(0.8).toFixed(1));

// current banding result
const tierCounts = [0, 0, 0, 0, 0];
for (const s of scores) tierCounts[S.scoreToTier(s.score) - 1]++;
console.log('current TIER_BANDS bucket counts:', tierCounts);

// a few sample rows
console.log('\nsamples (easiest, median, hardest):');
const show = (s) => console.log(`  #${s.dn}  score=${s.score.toFixed(1)}  len=${s.len}  nodes=${s.nodes}  choice=${s.choice}`);
show(scores[0]); show(scores[Math.floor(scores.length / 2)]); show(scores[scores.length - 1]);
