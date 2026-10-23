// Replays the app's hands (from tests/parity/main.swift) on the web version: every
// computer decision, every result and score must match.
//   jsc tests/args.js -m tests/parity/parity.js -- /tmp/gin_parity/hands.jsonl
import * as G from '../../js/game.js';
import { chooseMove } from '../../js/computer.js';

const file = (globalThis.scriptArgs || [])[0] || '/tmp/gin_parity/hands.jsonl';
const lines = readFile(file).split('\n').filter(Boolean).map((l) => JSON.parse(l));
let hands = 0, decisions = 0, bad = 0, badResults = 0;
const show = (o) => JSON.stringify(o);
for (const r of lines) {
  hands++;
  const g = G.newGame(r.dealer, r.deck);
  g.scores = r.before.slice();
  for (const m of r.moves) {
    decisions++;
    const mine = chooseMove(g, m.seat);
    if (mine.type !== m.type || (mine.card ?? null) !== (m.card ?? null)) { if (bad++ < 8) print(`DIFF move: app ${show(m)} web ${show(mine)}`); }
    G.apply(g, { type: m.type, card: m.card }, m.seat);
  }
  const res = g.result;
  const same = res.kind === r.kind && res.points === r.points && (res.winner ?? -1) === r.winner &&
    g.scores.join() === r.after.join() && g.phase === r.phase && res.arrangements.map((a) => a.deadwood.reduce((n, c) => n + Math.min(c % 100, 10), 0)).join() === r.deadwood.join();
  if (!same && badResults++ < 8) print(`DIFF result: app ${show([r.kind, r.points, r.winner, r.after, r.deadwood])} web ${show([res.kind, res.points, res.winner, g.scores])}`);
}
print(`${hands} hands, ${decisions} computer decisions: ${bad} decisions differ, ${badResults} results differ`);
