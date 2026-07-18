/* VP4 — generator guarantee. Validates the shipped deal pool (deals.js):
 *   - 0 unsolvable deals
 *   - every deal's graded difficulty falls in its tier's band
 *   - Fort Knox deals are solvable with only 3 free cells
 * Usage: node tests/test-generator.js [perTier]   (default: full pool)
 */
const G = require('../game.js');
const S = require('../solver.js');
const { DEAL_POOL } = require('../deals.js');

const PER = parseInt(process.argv[2] || '0', 10); // 0 = all
let pass = 0, fail = 0;
const problems = [];

const t0 = Date.now();
for (let tier = 1; tier <= 5; tier++) {
  const deals = PER > 0 ? DEAL_POOL[tier].slice(0, PER) : DEAL_POOL[tier];
  let unsolvable = 0, wrongTier = 0, fkBad = 0;
  for (const dn of deals) {
    const g = S.gradeDeal(dn);
    if (!g.solvable) { unsolvable++; problems.push(`tier ${tier} #${dn}: not solvable (grade)`); continue; }
    if (g.tier !== tier) { wrongTier++; problems.push(`tier ${tier} #${dn}: graded tier ${g.tier} (score ${g.score.toFixed(1)})`); }
    if (tier === 5) {
      const r3 = S.solve(G.newState(dn, 3), { maxNodes: 250000, weight: 3, wantPath: false });
      if (!r3.solvable) { fkBad++; problems.push(`tier 5 #${dn}: not solvable with 3 free cells`); }
    }
  }
  const okTier = unsolvable === 0 && wrongTier === 0 && fkBad === 0;
  console.log(`  ${okTier ? '✓' : '✗'} ${S.TIER_NAMES[tier - 1].padEnd(13)} n=${deals.length}  unsolvable=${unsolvable} wrongTier=${wrongTier}${tier === 5 ? ' fk3cellBad=' + fkBad : ''}`);
  if (okTier) pass++; else fail++;
}

console.log('\nchecked in ' + ((Date.now() - t0) / 1000).toFixed(0) + 's');
if (problems.length) { console.log('problems:'); problems.slice(0, 20).forEach((p) => console.log('   - ' + p)); }
console.log('----------------------------------------');
console.log(`  ${pass}/5 tiers clean`);
process.exit(fail ? 1 : 0);
