/* Probe solver speed/strength across weights, path off. node tools/probe.js */
const G = require('../game.js');
const S = require('../solver.js');

for (const W of [2, 3, 4]) {
  let solved = 0, capped = 0, nodesTot = 0, t0 = Date.now();
  const N = 150;
  for (let dn = 1; dn <= N; dn++) {
    const r = S.solve(G.newState(dn, 4), { maxNodes: 200000, weight: W, wantPath: false });
    if (r.solvable) { solved++; nodesTot += r.nodes; }
    else capped++;
  }
  console.log(`W=${W}: solved ${solved}/${N}, capped ${capped}, avgNodes ${Math.round(nodesTot / solved)}, ${((Date.now() - t0) / 1000).toFixed(1)}s (${((Date.now() - t0) / N).toFixed(0)}ms/deal)`);
}
