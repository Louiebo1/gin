// Run with: jsc -m tests/engine.test.js   (from the project folder)
import * as G from '../js/game.js';
import { best, deadwoodCount, defend } from '../js/melds.js';
import { card, CLUBS, DIAMONDS, SPADES, HEARTS } from '../js/cards.js';
import { chooseMove } from '../js/computer.js';

let failures = 0, checks = 0;
function expect(ok, what) { checks++; if (!ok) { failures++; print('FAIL: ' + what); } }
const C = (r) => card(CLUBS, r), D = (r) => card(DIAMONDS, r), S = (r) => card(SPADES, r), H = (r) => card(HEARTS, r);

// Melds.
expect(deadwoodCount(best([C(1), C(2), C(3), D(7), S(7), H(7), C(13), D(13), S(13), H(5)])) === 5, 'run, two sets, a 5 left');
expect(best([H(4), H(5), H(6), H(7), C(7), S(7)]).deadwood.length === 0, 'the 7♥ goes to whichever meld leaves nothing over');
const knockMelds = [{ kind: 'run', cards: [H(4), H(5), H(6)] }];
expect(defend([H(7), H(8), C(13)], knockMelds).layoffs.length === 2, 'lay off a run card by card');

// Whole games of the computer against itself: every move legal, the game ends.
for (let n = 0; n < 30; n++) {
  const g = G.newGame();
  let steps = 0;
  while (g.phase !== 'gameOver' && ++steps < 20000) {
    if (g.phase === 'handOver') { G.nextHand(g); continue; }
    const m = chooseMove(g, g.turn);
    expect(G.canApply(g, m, g.turn), 'the computer moves legally');
    G.apply(g, m, g.turn);
  }
  const f = G.finalScore(g);
  expect(g.phase === 'gameOver' && g.scores[g.winner] >= 100, 'a game ends at 100');
  expect(f.totals[g.winner] === (g.scores[g.winner] + g.handsWon[g.winner] * 25 + 100) * (f.shutout ? 2 : 1), 'final score adds up');
}

// Next Hand between two people waits for both, or the deadline.
{
  const g = G.newGame(0);
  g.phase = 'handOver'; g.result = { kind: 'knock' };
  G.markContinued(g, 1, 5000);
  expect(g.phase === 'handOver' && g.continueDeadline === 5000 + G.CONTINUE_WAIT, 'one tap waits');
  G.markContinued(g, 0, 6000);
  expect(g.phase === 'upcard' && g.handNumber === 1 && g.dealer === 1, 'both taps deal; the deal alternates');
}
print(`${checks} checks, ${failures} failures`);
