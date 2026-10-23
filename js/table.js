// A gin table: the game plus who sits where (a person or the computer). The host (this
// device against the computer; one of the two browsers online) applies every move, plays
// the computer and keeps time. Plain data, so the same table runs locally or online.

import * as G from './game.js';
import { chooseMove } from './computer.js';

/** How long the computer waits before a move (ms), as in the app. */
export const PACE = { draw: 640, discard: 800, autoplayHand: 4000 };

const GAME_MOVES = ['takeUpcard', 'passUpcard', 'drawStock', 'drawDiscard', 'discard', 'knock'];

/** A fresh table: seats are [{ kind: 'person' | 'computer', name }]. */
export function newTableState(seats) {
  return { game: G.newGame(), seats, version: 0, paused: null };
}

const people = (state) => state.seats.filter((s) => s.kind === 'person').length;

/** Apply one move (from anyone) to the table. Returns true if it changed anything. */
export function applyMove(state, move, now = Date.now()) {
  const g = state.game;
  try {
    if (GAME_MOVES.includes(move.type)) {
      G.apply(g, { type: move.type, ...(move.card !== undefined ? { card: move.card } : {}) }, move.seat);
    } else {
      switch (move.type) {
        case 'continue':
          if (move.hand !== g.handNumber || g.phase !== 'handOver') return false;
          // Against the computer the next hand is dealt at once; two people both tap it
          // (or the first tap starts the other's 30 seconds).
          if (people(state) < 2) G.nextHand(g); else G.markContinued(g, move.seat, now);
          break;
        case 'timeUp':
          if (g.phase !== 'handOver' || g.continueDeadline === null || now < g.continueDeadline) return false;
          G.nextHand(g);
          break;
        case 'newGame':
          state.game = G.newGame();
          break;
        default: return false;
      }
    }
  } catch (e) {
    if (!(e instanceof G.IllegalMove)) throw e;
    return false;
  }
  state.version += 1;
  return true;
}

/** The next thing the host does on its own (the computer's move, or the end of the 30
 *  seconds), with how long to wait first — or null when it's waiting on a person. */
export function nextHostStep(state, now = Date.now()) {
  if (state.paused) return null;
  const g = state.game;
  const isComputer = (s) => state.seats[s].kind === 'computer';
  if (['upcard', 'drawing', 'discarding'].includes(g.phase)) {
    const s = g.turn;
    if (!isComputer(s)) return null;
    return { delay: g.phase === 'discarding' ? PACE.discard : PACE.draw, move: () => ({ ...chooseMove(g, s), seat: s }) };
  }
  if (g.phase === 'handOver') {
    if (g.continueDeadline !== null) return { delay: Math.max(0, g.continueDeadline - now), move: () => ({ type: 'timeUp' }) };
    // A table of only computers (testing) moves on by itself.
    if (!people(state)) return { delay: PACE.autoplayHand, move: () => ({ type: 'continue', seat: 0, hand: g.handNumber }) };
  }
  return null;
}

/** Runs a table on this device (against the computer). `onState` gets every new state. */
export class LocalHost {
  constructor(state, onState) {
    this.state = state;
    this.onState = onState;
    this.timer = null;
    this.publish();
  }

  send(move) {
    if (applyMove(this.state, move)) this.publish();
  }

  publish() {
    this.onState(this.state);
    this.schedule();
  }

  schedule() {
    clearTimeout(this.timer);
    const step = nextHostStep(this.state);
    if (!step) return;
    const version = this.state.version;
    this.timer = setTimeout(() => {
      if (this.state.version === version && applyMove(this.state, step.move())) this.publish();
    }, step.delay);
  }

  stop() { clearTimeout(this.timer); }
}
