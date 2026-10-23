// Cards are small integers: suit * 100 + rank (rank 1–13; the ace is low in cribbage).
// Suits in display order alternate black/red: clubs, diamonds, spades, hearts — the
// same as the app.

export const CLUBS = 0, DIAMONDS = 1, SPADES = 2, HEARTS = 3;
export const SUITS = [CLUBS, DIAMONDS, SPADES, HEARTS];
export const SYMBOL = ['♣', '♦', '♠', '♥'];

export const card = (suit, rank) => suit * 100 + rank;
export const suitOf = (c) => Math.floor(c / 100);
export const rankOf = (c) => c % 100;
export const isRed = (c) => suitOf(c) === DIAMONDS || suitOf(c) === HEARTS;
/** Counting value: ace 1, face cards 10. */
export const valueOf = (c) => Math.min(rankOf(c), 10);
export const isJack = (c) => rankOf(c) === 11;

export function rankLabel(c) {
  const r = rankOf(c);
  return { 1: 'A', 11: 'J', 12: 'Q', 13: 'K' }[r] || String(r);
}

export const label = (c) => rankLabel(c) + SYMBOL[suitOf(c)];

export const FULL_DECK = SUITS.flatMap((s) => Array.from({ length: 13 }, (_, i) => card(s, i + 1)));

/** Rank first, then suit: the way you read a cribbage hand for runs and fifteens. */
export const compareCards = (a, b) => (rankOf(a) !== rankOf(b) ? rankOf(a) - rankOf(b) : suitOf(a) - suitOf(b));
export const sorted = (cards) => cards.slice().sort(compareCards);

/** A shuffled copy of the deck (Fisher–Yates). */
export function shuffled(deck = FULL_DECK, random = Math.random) {
  const d = deck.slice();
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}
