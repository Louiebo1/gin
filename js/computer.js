// The computer opponent, ported from the app's `ComputerPlayer`. It sees only its own
// hand, the discard pile, and what the other player has taken from the pile and thrown.
//   Draw: take the upcard only if it goes into a meld (or lets it knock).
//   Discard: the card leaving the least deadwood, keeping cards close to melds, and not
//   feeding the opponent (a card next to what they've picked up is dangerous; one like
//   what they've thrown is safer).
//   Knock: right away early in the hand; later it needs less deadwood.

import { rankOf, suitOf, card } from './cards.js';
import { best, deadwoodCount } from './melds.js';
import { KNOCK_LIMIT, upcard, stockCount } from './game.js';

const CONNECT_WEIGHT = 0.6, DANGER_WEIGHT = 0.2;

export function chooseMove(game, me) {
  switch (game.phase) {
    case 'upcard':
      return { type: upcard(game) !== null && wants(upcard(game), game, me) ? 'takeUpcard' : 'passUpcard' };
    case 'drawing':
      if (!game.mustDrawStock && upcard(game) !== null && wants(upcard(game), game, me)) return { type: 'drawDiscard' };
      return { type: 'drawStock' };
    case 'discarding': {
      const c = bestDiscard(game, me);
      const deadwood = deadwoodCount(best(game.hands[me].filter((x) => x !== c)));
      return { type: deadwood <= knockThreshold(game) ? 'knock' : 'discard', card: c };
    }
    default:
      return { type: 'drawStock' };     // Not a turn.
  }
}

/** Whether to take `c` from the pile: it joins a meld, or it lets us knock. */
export function wants(c, game, me) {
  const hand = [...game.hands[me], c];
  const now = best(game.hands[me]);
  let bestDeadwood = Infinity, melded = false;
  for (const d of hand) {
    if (d === c) continue;
    const arr = best(hand.filter((x) => x !== d));
    if (deadwoodCount(arr) < bestDeadwood) { bestDeadwood = deadwoodCount(arr); melded = !arr.deadwood.includes(c); }
  }
  if (melded && bestDeadwood < deadwoodCount(now)) return true;
  return bestDeadwood <= knockThreshold(game) && bestDeadwood < deadwoodCount(now);
}

export function knockThreshold(game) {
  const n = stockCount(game);
  if (n >= 22) return KNOCK_LIMIT;
  if (n >= 14) return 7;
  if (n >= 8) return 5;
  return 2;
}

export function bestDiscard(game, me) {
  const hand = game.hands[me];
  const options = hand.filter((c) => c !== game.takenFromPile);
  const opponent = 1 - me;
  const theirCards = new Set(game.pickedUp[opponent].filter((c) => !game.thrown[opponent].includes(c)));
  const theirThrows = game.thrown[opponent];
  // Cards no one can draw any more: mine, under the top of the pile, or known to be theirs.
  const dead = new Set([...hand, ...game.discards.slice(0, -1), ...theirCards]);
  const rating = (c) => {
    const arr = best(hand.filter((x) => x !== c));
    return deadwoodCount(arr) - CONNECT_WEIGHT * connections(arr.deadwood, dead) + DANGER_WEIGHT * danger(c, theirCards, theirThrows);
  };
  let pick = options[0], pickValue = rating(pick);
  for (const c of options.slice(1)) { const v = rating(c); if (v < pickValue) { pick = c; pickValue = v; } }
  return pick;
}

/** How close the deadwood is to melds: pairs, and same-suit cards one or two apart, as
 *  long as a card that would complete them can still turn up. */
function connections(deadwood, dead) {
  let total = 0;
  for (let i = 0; i < deadwood.length; i++) {
    for (let j = i + 1; j < deadwood.length; j++) {
      const a = deadwood[i], b = deadwood[j];
      if (rankOf(a) === rankOf(b)) {
        if ([0, 1, 2, 3].some((s) => s !== suitOf(a) && s !== suitOf(b) && !dead.has(card(s, rankOf(a))))) total += 2;
      } else if (suitOf(a) === suitOf(b) && Math.abs(rankOf(a) - rankOf(b)) <= 2) {
        const low = Math.min(rankOf(a), rankOf(b)), high = Math.max(rankOf(a), rankOf(b));
        const completing = high - low === 1 ? [low - 1, high + 1] : [low + 1];
        if (completing.some((r) => r >= 1 && r <= 13 && !dead.has(card(suitOf(a), r)))) total += high - low === 1 ? 2 : 1;
      }
    }
  }
  return total;
}

/** How likely `c` is to help the opponent, judging by what they've picked up and thrown. */
function danger(c, theirCards, theirThrows) {
  let risk = 0;
  for (const t of theirCards) {
    if (rankOf(t) === rankOf(c)) risk += 6;
    if (suitOf(t) === suitOf(c) && Math.abs(rankOf(t) - rankOf(c)) <= 2) risk += 5;
  }
  for (const t of theirThrows) {
    if (rankOf(t) === rankOf(c)) risk -= 1.5;
    if (suitOf(t) === suitOf(c) && Math.abs(rankOf(t) - rankOf(c)) === 1) risk -= 1;
  }
  return risk;
}
