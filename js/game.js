// A two-player game of standard Gin Rummy to 100, ported from the app's `GinGame`. The
// game is a plain object (JSON-safe, so it can be stored in Firebase) changed by these
// functions; an illegal move throws `IllegalMove` and changes nothing. Seats are 0 and 1.
//
// Rules (Louie's, 2026-10-18): 10 cards each. The non-dealer may take the first upcard
// or pass, then the dealer; if both pass, the non-dealer draws from the stock. Each turn:
// draw (stock or pile), then discard — not the card just taken from the pile. Knock with
// 10 or less deadwood; gin (no deadwood) scores 25 and allows no lay-offs. The defender
// lays off on the knocker's melds; equal or lower deadwood is an undercut (25 + the
// difference). Stock down to 2 cards: a drawn hand. Game to 100; then 25 per hand won
// (boxes), 100 for the game, and a shutout doubles it all.

import { shuffled, sorted } from './cards.js';
import { best, defend, deadwoodCount, isGin } from './melds.js';

export const TARGET = 100, KNOCK_LIMIT = 10, GIN_BONUS = 25, UNDERCUT_BONUS = 25, BOX_BONUS = 25, GAME_BONUS = 100;
export const HAND_SIZE = 10;
/** The hand is a draw once the stock is down to this many cards. */
export const DEAD_STOCK = 2;
/** A safety stop: a hand of endless trading through the pile is a draw after this many discards. */
export const MAX_DISCARDS = 150;
/** Two people: once one taps Continue after a hand, the other has this long (ms). */
export const CONTINUE_WAIT = 30000;

export class IllegalMove extends Error {}
const check = (ok) => { if (!ok) throw new IllegalMove('illegal'); };

export function newGame(dealer = Math.floor(Math.random() * 2), deck = shuffled()) {
  const game = { scores: [0, 0], handsWon: [0, 0], dealer, handNumber: 0, history: [], winner: null };
  deal(game, deck);
  return game;
}

export const pone = (game) => 1 - game.dealer;
export const upcard = (game) => (game.discards.length ? game.discards[game.discards.length - 1] : null);
export const stockCount = (game) => game.stock.length;

function deal(game, deck) {
  check(deck.length === 52 && new Set(deck).size === 52);
  game.stock = deck.slice();
  game.hands = [[], []];
  for (let i = 0; i < HAND_SIZE * 2; i++) game.hands[(pone(game) + i) % 2].push(game.stock.shift());
  game.hands = game.hands.map(sorted);
  game.discards = [game.stock.shift()];   // The top card is last.
  game.takenFromPile = null;              // Just taken from the pile: can't go straight back.
  game.passedUpcard = [];
  game.mustDrawStock = false;             // Both passed on the upcard.
  game.pickedUp = [[], []];               // Taken from the pile this hand (seen by both).
  game.thrown = [[], []];                 // Discarded this hand.
  game.lastMove = null;
  game.lastMover = null;
  game.result = null;
  game.continued = null;
  game.continueDeadline = null;
  game.phase = 'upcard';                  // upcard → drawing ⇄ discarding → handOver (→ gameOver)
  game.turn = pone(game);
}

/** Moves: { type: 'takeUpcard' | 'passUpcard' | 'drawStock' | 'drawDiscard' } or
 *  { type: 'discard' | 'knock', card }. */
export function apply(game, move, player) {
  check(player === game.turn);
  const { phase } = game;
  switch (`${phase}:${move.type}`) {
    case 'upcard:takeUpcard': takeTopDiscard(game, player); break;
    case 'upcard:passUpcard':
      if (!game.passedUpcard.includes(player)) game.passedUpcard.push(player);
      if (game.passedUpcard.length === 2) { game.phase = 'drawing'; game.mustDrawStock = true; game.turn = pone(game); }
      else game.turn = 1 - player;
      break;
    case 'drawing:drawStock':
      game.hands[player] = sorted([...game.hands[player], game.stock.shift()]);
      game.takenFromPile = null;
      game.mustDrawStock = false;
      game.phase = 'discarding';
      break;
    case 'drawing:drawDiscard':
      check(!game.mustDrawStock && game.discards.length);
      takeTopDiscard(game, player);
      break;
    case 'discarding:discard':
      discardCard(game, move.card, player);
      if (game.stock.length <= DEAD_STOCK || game.thrown[0].length + game.thrown[1].length >= MAX_DISCARDS) {
        endHand(game, { kind: 'draw', knocker: null, winner: null, points: 0, arrangements: game.hands.map(best), layoffs: [] });
      } else {
        game.turn = 1 - player;
        game.phase = 'drawing';
      }
      break;
    case 'discarding:knock':
      check(game.hands[player].includes(move.card) && move.card !== game.takenFromPile &&
        deadwoodCount(best(game.hands[player].filter((c) => c !== move.card))) <= KNOCK_LIMIT);
      discardCard(game, move.card, player);
      knock(game, player);
      break;
    default: check(false);
  }
  game.lastMove = { ...move };
  game.lastMover = player;
}

export function canApply(game, move, player) {
  try { apply(JSON.parse(JSON.stringify(game)), move, player); return true; } catch { return false; }
}

function takeTopDiscard(game, player) {
  const c = game.discards.pop();
  game.hands[player] = sorted([...game.hands[player], c]);
  game.pickedUp[player].push(c);
  game.takenFromPile = c;
  game.phase = 'discarding';
}

function discardCard(game, c, player) {
  check(game.hands[player].includes(c) && c !== game.takenFromPile);
  game.hands[player] = game.hands[player].filter((x) => x !== c);
  game.discards.push(c);
  game.thrown[player].push(c);
  game.takenFromPile = null;
}

// MARK: The knock and the score

function knock(game, knocker) {
  const defender = 1 - knocker;
  const knockerHand = best(game.hands[knocker]);
  const arranged = (defence) => (knocker === 0 ? [knockerHand, defence] : [defence, knockerHand]);
  if (isGin(knockerHand)) {
    const defence = best(game.hands[defender]);
    return endHand(game, { kind: 'gin', knocker, winner: knocker, points: deadwoodCount(defence) + GIN_BONUS, arrangements: arranged(defence), layoffs: [] });
  }
  const { arrangement: defence, layoffs } = defend(game.hands[defender], knockerHand.melds);
  const difference = deadwoodCount(defence) - deadwoodCount(knockerHand);
  if (difference <= 0) {
    endHand(game, { kind: 'undercut', knocker, winner: defender, points: -difference + UNDERCUT_BONUS, arrangements: arranged(defence), layoffs });
  } else {
    endHand(game, { kind: 'knock', knocker, winner: knocker, points: difference, arrangements: arranged(defence), layoffs });
  }
}

function endHand(game, result) {
  game.result = result;
  game.history.push(result);
  game.phase = 'handOver';
  if (result.winner !== null) {
    game.scores[result.winner] += result.points;
    game.handsWon[result.winner] += 1;
    if (game.scores[result.winner] >= TARGET) { game.winner = result.winner; game.phase = 'gameOver'; }
  }
}

/** Two people: the next hand is dealt once both have tapped Continue. The first tap
 *  starts the other player's 30 seconds (`continueDeadline`, ms since 1970). */
export function markContinued(game, player, now = Date.now()) {
  check(game.phase === 'handOver');
  const ready = new Set(game.continued || []);
  ready.add(player);
  if (ready.size === 2) return nextHand(game);
  game.continued = [...ready];
  if (game.continueDeadline === null) game.continueDeadline = now + CONTINUE_WAIT;
}

/** Deals the next hand. The deal alternates; a drawn hand is dealt again by the same dealer. */
export function nextHand(game, deck = shuffled()) {
  check(game.phase === 'handOver');
  if (!game.result || game.result.kind !== 'draw') game.dealer = pone(game);
  game.handNumber += 1;
  deal(game, deck);
}

/** The end-of-game totals: points, 25 per hand won, 100 for the winner, and a shutout
 *  (the loser never scored) doubles the winner's total. */
export function finalScore(game) {
  const w = game.winner;
  if (w === null) return null;
  const boxes = game.handsWon.map((n) => n * BOX_BONUS);
  const bonus = [0, 0]; bonus[w] = GAME_BONUS;
  const shutout = game.scores[1 - w] === 0;
  const totals = [0, 1].map((s) => game.scores[s] + boxes[s] + bonus[s]);
  if (shutout) totals[w] *= 2;
  return { points: game.scores.slice(), boxes, gameBonus: bonus, shutout, totals, margin: totals[w] - totals[1 - w] };
}

// MARK: Helpers for players

export const arrangement = (game, player) => best(game.hands[player]);

/** The discards that would let `player` knock (or go gin) right now. */
export function knockingDiscards(game, player) {
  if (game.phase !== 'discarding' || game.turn !== player) return [];
  return game.hands[player].filter((c) => c !== game.takenFromPile && deadwoodCount(best(game.hands[player].filter((x) => x !== c))) <= KNOCK_LIMIT);
}

export const ginDiscards = (game, player) =>
  knockingDiscards(game, player).filter((c) => isGin(best(game.hands[player].filter((x) => x !== c))));
