// Melds, ported from the app's `Melds`: a set (3 or 4 of a rank) or a run (3+ in a row of
// one suit, ace low). A meld is { kind: 'set' | 'run', cards } with the cards by rank; an
// arrangement is { melds, deadwood } with the deadwood sorted.

import { rankOf, suitOf, valueOf, sorted } from './cards.js';

export const meld = (kind, cards) => ({ kind, cards: sorted(cards) });

/** Whether `c` can be added to this meld ("laid off"). */
export function accepts(m, c) {
  if (m.cards.includes(c)) return false;
  if (m.kind === 'set') return m.cards.length < 4 && rankOf(c) === rankOf(m.cards[0]);
  return suitOf(c) === suitOf(m.cards[0]) &&
    (rankOf(c) === rankOf(m.cards[0]) - 1 || rankOf(c) === rankOf(m.cards[m.cards.length - 1]) + 1);
}

export const deadwoodCount = (arr) => arr.deadwood.reduce((n, c) => n + valueOf(c), 0);
export const isGin = (arr) => arr.deadwood.length === 0;

/** Every meld that can be made from `cards`: sets of 3 and 4 (and each 3 of a 4), and
 *  every run of 3 or more. */
export function candidates(cards) {
  const melds = [];
  for (let r = 1; r <= 13; r++) {
    const group = cards.filter((c) => rankOf(c) === r);
    if (group.length < 3) continue;
    melds.push(meld('set', group));
    if (group.length === 4) for (const skip of group) melds.push(meld('set', group.filter((c) => c !== skip)));
  }
  for (let s = 0; s < 4; s++) {
    const group = cards.filter((c) => suitOf(c) === s);
    if (group.length < 3) continue;
    const ranks = new Set(group.map(rankOf));
    for (let start = 1; start <= 11; start++) {
      if (!ranks.has(start)) continue;
      let end = start;
      while (ranks.has(end + 1)) end++;
      if (end - start < 2) continue;
      // Every run of 3+ inside this stretch that begins at `start`.
      for (let last = start + 2; last <= end; last++) melds.push(meld('run', group.filter((c) => rankOf(c) >= start && rankOf(c) <= last)));
    }
  }
  return melds;
}

const count = (cards) => cards.reduce((n, c) => n + valueOf(c), 0);

/** The arrangement with the least deadwood (ties: more cards melded). */
export function best(cards) {
  const melds = candidates(cards);
  let bestArr = { melds: [], deadwood: sorted(cards) };
  let bestCount = count(cards);
  const chosen = [];
  const search = (index, used) => {
    const deadwood = cards.filter((c) => !used.has(c));
    const n = count(deadwood);
    if (n < bestCount || (n === bestCount && deadwood.length < bestArr.deadwood.length)) {
      bestCount = n;
      bestArr = { melds: chosen.slice(), deadwood: sorted(deadwood) };
    }
    if (index >= melds.length || bestCount === 0) return;
    for (let i = index; i < melds.length; i++) {
      const m = melds[i];
      if (m.cards.some((c) => used.has(c))) continue;
      chosen.push(m);
      search(i + 1, new Set([...used, ...m.cards]));
      chosen.pop();
      if (bestCount === 0) return;
    }
  };
  search(0, new Set());
  return bestArr;
}

/** Every arrangement that is locally maximal (no further meld fits in the deadwood), for
 *  working out the defender's best lay-offs. */
export function allMaximal(cards) {
  const melds = candidates(cards);
  const results = [], chosen = [];
  const search = (index, used) => {
    let extended = false;
    for (let i = index; i < melds.length; i++) {
      const m = melds[i];
      if (m.cards.some((c) => used.has(c))) continue;
      extended = true;
      chosen.push(m);
      search(i + 1, new Set([...used, ...m.cards]));
      chosen.pop();
    }
    if (!extended && !melds.some((m) => m.cards.every((c) => !used.has(c)))) {
      results.push({ melds: chosen.slice(), deadwood: sorted(cards.filter((c) => !used.has(c))) });
    }
  };
  search(0, new Set());
  return results.length ? results : [{ melds: [], deadwood: sorted(cards) }];
}

/** The defender's best showing against a knock: their own melds plus the cards they can
 *  lay off on the knocker's melds, leaving the least deadwood. */
export function defend(cards, knockerMelds) {
  let result = null;
  for (const arr of allMaximal(cards)) {
    const targets = knockerMelds.map((m) => ({ kind: m.kind, cards: m.cards.slice() }));
    let deadwood = arr.deadwood.slice();
    const layoffs = [];
    // Keep laying off until nothing more fits (a run can grow card by card).
    let changed = true;
    while (changed) {
      changed = false;
      for (const c of deadwood.slice().sort((a, b) => valueOf(b) - valueOf(a))) {
        const t = targets.findIndex((m) => accepts(m, c));
        if (t >= 0) {
          targets[t] = meld(targets[t].kind, [...targets[t].cards, c]);
          deadwood = deadwood.filter((x) => x !== c);
          layoffs.push(c);
          changed = true;
        }
      }
    }
    const shown = { melds: arr.melds, deadwood: sorted(deadwood) };
    if (result === null || deadwoodCount(shown) < deadwoodCount(result.arrangement)) result = { arrangement: shown, layoffs };
  }
  return result;
}


