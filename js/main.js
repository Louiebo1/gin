// The web app: the start screen, the table, the hand's result and the dialogs. It draws
// whatever table state it's given and turns taps into moves. "Me" is seat 0 against the
// computer and for whoever started an online game; the friend who joined is seat 1.

import * as G from './game.js';
import { SYMBOL, suitOf, rankLabel, isRed, label, rankOf, card, HEARTS, CLUBS, SPADES, DIAMONDS } from './cards.js';
import { deadwoodCount, best } from './melds.js';
import { chooseMove } from './computer.js';
import { newTableState, LocalHost, applyMove, PACE } from './table.js';
import { OnlineTable, onlineAvailable } from './online.js';
import { play as playSound, unlockSound, sound } from './sounds.js';

const app = document.getElementById('app');
// For checking the page: ?name=X, ?play, ?autoplay (the computer plays both seats),
// ?fast, ?newgame=CODE (start an online game with that code), ?g=CODE.
const params = new URLSearchParams(location.search);
const MY_COLOR = '#f26b40', THEIR_COLOR = '#4d99f7';
/** The hand just ended: the result waits a moment so "Gin!" can be seen first (ms). */
const RESULT_HOLD = 1800;

// MARK: Remembered on this device

function stored(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function store(key, value) {
  try { value === null ? localStorage.removeItem(key) : localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

const settings = Object.assign({ name: '', back: 'red', highFirst: true, largePrint: false, sounds: true, hints: false, bySuit: false },
  stored('gin.settings', {}));
function saveSettings() {
  store('gin.settings', settings);
  document.body.classList.toggle('large-print', settings.largePrint);
  sound.on = settings.sounds;
}
saveSettings();

/** Wins and losses on this device, by kind of game. */
const stats = Object.assign({ computer: { won: 0, lost: 0, shutouts: 0 }, online: { won: 0, lost: 0, shutouts: 0 } }, stored('gin.stats', {}));
const recordText = () => {
  const won = stats.computer.won + stats.online.won, lost = stats.computer.lost + stats.online.lost;
  return won + lost ? `${won} win${won === 1 ? '' : 's'} · ${lost} loss${lost === 1 ? '' : 'es'}` : 'No games yet';
};

// The online game this browser last played, so the start screen can offer to go back.
const lastOnline = { get: () => stored('gin.online', null), set: (c) => store('gin.online', c), clear: () => store('gin.online', null) };
// A game against the computer, saved after every move.
const savedGame = { get: () => stored('gin.local', null), set: (s) => store('gin.local', s) };

const myName = () => settings.name || 'Player';

// MARK: Helpers

/** Names come from other people's browsers: never let them be read as HTML. */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; };
function button(text, cls, onclick) {
  const b = el('button', cls);
  b.textContent = text;
  b.onclick = onclick;
  return b;
}

function cardEl(c) {
  const e = el('div', 'card' + (isRed(c) ? ' red' : ''));
  e.innerHTML = `<div class="corner"><span class="r">${rankLabel(c)}</span><span class="s">${SYMBOL[suitOf(c)]}</span></div><div class="pip">${SYMBOL[suitOf(c)]}</div>`;
  e.setAttribute('aria-label', label(c));
  return e;
}

function backEl() {
  const e = el('div', 'back');
  const inner = el('div');
  inner.style.backgroundImage = `url(img/back_${settings.back}.jpg)`;
  e.appendChild(inner);
  return e;
}

/** A dialog over the page; Escape or a tap outside calls `dismiss`, when there is one. */
function dialog(title, body, buttons, dismiss) {
  const o = el('div', 'overlay'), p = el('div', 'panel');
  if (title) p.appendChild(el('h2', '', title));
  if (typeof body === 'string') p.appendChild(el('p', '', body));
  else if (body) p.appendChild(body);
  if (buttons && buttons.length) { const row = el('div', 'buttons'); row.append(...buttons); p.appendChild(row); }
  o.appendChild(p);
  if (dismiss) {
    o.dataset.dismiss = '';
    o.dismiss = dismiss;
    o.onclick = (e) => { if (e.target === o) dismiss(); };
  }
  return o;
}

/** A dialog of its own that stays on top while the table redraws under it.
 *  `buttons` are [text, class, action]; each one closes it. */
function popup(title, body, buttons, onDismiss) {
  const o = dialog(title, body, buttons.map(([text, cls, then]) => button(text, cls, () => { o.remove(); then?.(); })),
    () => { o.remove(); onDismiss?.(); });
  o.classList.add('popup');
  app.appendChild(o);
  return o;
}
const message = (html, then) => popup('', html, [['OK', 'primary', then]], then);
const confirmThen = (title, html, yes, onYes) => popup(title, html, [['Cancel', ''], [yes, 'primary', onYes]]);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') [...document.querySelectorAll('.overlay[data-dismiss]')].pop()?.dismiss();
});
// Browsers only play sound after a tap.
document.addEventListener('pointerdown', unlockSound, { capture: true });

// MARK: State

let host = null;      // LocalHost or OnlineTable
let state = null;     // The table state being shown.
const ui = {
  me: 0,
  pending: null,         // The card picked to throw: it waits for a second tap.
  knocking: false,       // Knock mode: the next card thrown is face down to knock.
  hint: null, hintCard: null,
  banner: null,          // { title, detail, player, big, until }
  holdResultUntil: 0,
  guess: null,           // Online guest: my move shown before the host confirms it.
  prev: null,            // The last game drawn (a copy), to see what changed.
  recorded: false,       // This game's result is in the stats.
  showFinal: false,      // Game over: the final score instead of the last hand.
  overlayKey: null,
};
const later = [];        // Timers that redraw when something on the table expires.

function resetUI() {
  Object.assign(ui, { pending: null, knocking: false, hint: null, hintCard: null, banner: null, holdResultUntil: 0,
    guess: null, prev: null, recorded: false, showFinal: false, overlayKey: null });
  later.splice(0).forEach(clearTimeout);
}

const isOnline = () => host instanceof OnlineTable;
const shown = () => (ui.guess ? ui.guess.game : state.game);
const labelOf = (seat) => (seat === ui.me ? 'You' : esc(state.seats[seat].name));
const opponentName = () => esc(state.seats[1 - ui.me].name);
const myTurn = (g) => g.turn === ui.me && ['upcard', 'drawing', 'discarding'].includes(g.phase);

/** My hand's order: by number (rank) or by suit, highest first unless the setting says. */
function sortCards(cards) {
  const before = (a, b) => (settings.highFirst ? b - a : a - b);
  return cards.slice().sort((a, b) => (settings.bySuit
    ? (suitOf(a) !== suitOf(b) ? suitOf(a) - suitOf(b) : before(rankOf(a), rankOf(b)))
    : (rankOf(a) !== rankOf(b) ? before(rankOf(a), rankOf(b)) : suitOf(a) - suitOf(b))));
}

// MARK: Start screen

function leave() {
  host?.stop(); host = null; state = null;
  resetUI();
  showLobby();
}

function showLobby() {
  host?.stop(); host = null; state = null;
  if (location.search) history.replaceState(null, '', location.pathname);
  app.innerHTML = '';
  const lobby = el('div', 'lobby');
  const fan = el('div', 'fan');
  [card(HEARTS, 7), card(HEARTS, 8), card(HEARTS, 9), card(CLUBS, 13), card(DIAMONDS, 13), card(SPADES, 13)].forEach((c, i) => {
    const e = cardEl(c);
    e.style.transform = `rotate(${(i - 2.5) * 6}deg) translateY(${Math.abs(i - 2.5) * 4}px)`;
    fan.appendChild(e);
  });
  lobby.appendChild(fan);
  lobby.appendChild(el('h1', '', 'Gin Rummy'));
  lobby.appendChild(el('div', 'tag', 'Knock, gin, and watch for the undercut'));

  const name = el('div', 'name', 'Playing as ');
  name.appendChild(button(settings.name || 'You', 'link', () => askName(showLobby)));
  lobby.appendChild(name);
  lobby.appendChild(el('div', 'note', recordText()));

  const code = onlineAvailable() && lastOnline.get();
  if (code) lobby.appendChild(button(`Back to Game ${code}`, 'big-button primary', () => joinGame(code)));
  const saved = savedGame.get();
  if (saved && saved.game && saved.game.phase !== 'gameOver') {
    const g = saved.game;
    const b = el('button', 'big-button primary resume');
    b.innerHTML = `Continue Game<small>You ${g.scores[0]}, Computer ${g.scores[1]} · Hand ${g.handNumber + 1}</small>`;
    b.onclick = () => playComputer(saved);
    lobby.appendChild(b);
  }
  lobby.appendChild(button(saved && saved.game && saved.game.phase !== 'gameOver' ? 'New Game vs the Computer' : 'Play the Computer', 'big-button', () => playComputer()));
  const friends = button('Play with a Friend', 'big-button', showFriends);
  friends.disabled = !onlineAvailable();
  lobby.appendChild(friends);
  const links = el('div', 'links');
  links.append(button('Statistics', 'link', showStats), button('Settings', 'link', () => showSettings(showLobby)));
  lobby.appendChild(links);
  app.appendChild(lobby);
  if (!settings.name) askName(showLobby);
}

function askName(then) {
  const input = el('input', 'text');
  input.maxLength = 16; input.value = settings.name; input.placeholder = 'Your name'; input.autocomplete = 'nickname';
  const save = () => {
    const name = input.value.trim().slice(0, 16);
    if (!name) { input.focus(); return; }
    settings.name = name; saveSettings(); o.remove(); then?.();
  };
  input.onkeydown = (e) => { if (e.key === 'Enter') save(); };
  const o = dialog('Your name?', input, [button('OK', 'primary', save)], settings.name ? () => o.remove() : null);
  o.classList.add('popup');
  app.appendChild(o);
  input.focus();
}

function playComputer(saved = null) {
  const autoplay = params.has('autoplay');
  const s = saved || newTableState([{ kind: autoplay ? 'computer' : 'person', name: settings.name || 'You' }, { kind: 'computer', name: 'Computer' }]);
  ui.me = 0;
  resetUI();
  host = new LocalHost(s, (next) => {
    state = next;
    if (!autoplay) savedGame.set(next.game.phase === 'gameOver' ? null : next);
    update();
  });
}

// MARK: Playing a friend

function showFriends() {
  app.innerHTML = '';
  const lobby = el('div', 'lobby');
  lobby.appendChild(el('h1', '', 'Gin Rummy'));
  lobby.appendChild(el('div', 'tag', 'Play with a friend'));
  lobby.appendChild(button('Start a Game', 'big-button primary', () => withTable(OnlineTable.create(myName(), onTableUpdate))));
  lobby.appendChild(el('div', 'note', 'or join with your friend’s code'));
  const row = el('div', 'row');
  const input = el('input', 'code');
  input.maxLength = 4; input.placeholder = 'CODE'; input.autocapitalize = 'characters'; input.autocomplete = 'off'; input.spellcheck = false;
  const join = button('Join', 'primary', () => { if (input.value.trim().length === 4) joinGame(input.value.trim()); else input.focus(); });
  input.onkeydown = (e) => { if (e.key === 'Enter') join.onclick(); };
  row.append(input, join);
  lobby.appendChild(row);
  lobby.appendChild(el('div', 'note', 'Start a game, then send your friend the link (or the 4-letter code). If either of you drops, the game waits — reopen the link, or tap Back to Game on the start screen.'));
  lobby.appendChild(button('Back', '', showLobby));
  app.appendChild(lobby);
}

const joinGame = (code) => withTable(OnlineTable.join(code, myName(), onTableUpdate));

async function withTable(promise) {
  app.innerHTML = '<div class="lobby"><div class="tag">Connecting…</div></div>';
  resetUI();
  try {
    host = await promise;
    lastOnline.set(host.code);
    history.replaceState(null, '', `${location.pathname}?g=${host.code}`);
    onTableUpdate();
  } catch (e) {
    const text = (e && e.message) || String(e);
    if (/no game|two players/i.test(text)) lastOnline.clear();
    showFriends();
    message(esc(text));
  }
}

function onTableUpdate() {
  if (!isOnline()) return;
  ui.me = Math.max(0, host.mySeat);
  if (host.started && host.state) {
    state = host.state;
    if (ui.guess && state.version > ui.guess.base) ui.guess = null;
    update();
  } else waitingRoom();
}

function waitingRoom() {
  const t = host;
  state = null;
  app.innerHTML = '';
  const lobby = el('div', 'lobby');
  lobby.appendChild(el('div', 'tag', 'Your game code'));
  lobby.appendChild(el('h1', 'game-code', t.code));
  const link = `${location.origin}${location.pathname}?g=${t.code}`;
  const share = button('Send the Link', 'big-button primary', async () => {
    if (navigator.share) { try { await navigator.share({ title: 'Gin Rummy', text: `Play gin with me — game ${t.code}`, url: link }); } catch {} return; }
    try { await navigator.clipboard.writeText(link); share.textContent = 'Link Copied'; } catch { share.textContent = link; }
  });
  lobby.appendChild(share);
  lobby.appendChild(el('div', 'waiting', '<span class="dots"><i></i><i></i><i></i></span> Waiting for your friend to join…'));
  lobby.appendChild(el('div', 'note', 'The cards are dealt the moment they open the link or type the code.'));
  lobby.appendChild(button('Leave', '', () => { lastOnline.clear(); leave(); }));
  app.appendChild(lobby);
}

// MARK: Moves

function send(move) {
  if (isOnline() && !host.isHost) {
    // Show my own move at once; the host's state replaces it.
    const copy = JSON.parse(JSON.stringify(state));
    if (applyMove(copy, move)) ui.guess = { game: copy.game, base: state.version };
    host.send(move);
    update();
    return;
  }
  host.send(move);
}

function perform(type, c) {
  const g = shown();
  const move = { type, seat: ui.me, ...(c !== undefined ? { card: c } : {}) };
  if (!G.canApply(g, move, ui.me)) return;
  ui.knocking = false; ui.pending = null; ui.hint = null; ui.hintCard = null;
  send(move);
}

/** Why the stock or the pile can't be taken right now (null: it can). */
function cantTake(stock, g) {
  if (g.turn !== ui.me) return 'Wait for your turn.';
  switch (g.phase) {
    case 'upcard': return stock ? 'First take the upcard or pass.' : null;
    case 'drawing': return !stock && g.mustDrawStock ? 'This time you have to draw from the stock.' : null;
    case 'discarding': return 'You’ve drawn — now pick a card to discard.';
    default: return '';
  }
}

function tapStock() {
  const g = shown(), why = cantTake(true, g);
  if (why !== null) { if (why) { ui.hint = why; ui.hintCard = null; render(); } return; }
  perform('drawStock');
}

function tapPile() {
  const g = shown(), why = cantTake(false, g);
  if (why !== null) { if (why) { ui.hint = why; ui.hintCard = null; render(); } return; }
  perform(g.phase === 'upcard' ? 'takeUpcard' : 'drawDiscard');
}

/** A card in my hand: the first tap picks it, a second tap throws it (or knocks with it). */
function tapCard(c) {
  const g = shown();
  if (g.phase !== 'discarding' || g.turn !== ui.me) return;
  if (c === g.takenFromPile) { ui.hint = 'You can’t throw back the card you just took from the pile — pick another.'; ui.hintCard = null; render(); return; }
  if (ui.knocking && !G.knockingDiscards(g, ui.me).includes(c)) {
    ui.hint = 'Knocking with that card would leave too much deadwood — pick a highlighted card, or tap Knock again to cancel.';
    ui.hintCard = null; render(); return;
  }
  if (ui.pending === c) confirmDiscard();
  else { ui.pending = c; render(); }
}

function confirmDiscard() {
  const c = ui.pending;
  if (c === null) return;
  ui.pending = null;
  perform(ui.knocking ? 'knock' : 'discard', c);
}

function toggleKnocking() {
  const g = shown();
  const options = G.knockingDiscards(g, ui.me);
  if (!options.length) return;
  ui.knocking = !ui.knocking;
  if (ui.knocking && ui.pending !== null && !options.includes(ui.pending)) ui.pending = null;
  render();
}

/** What the computer would do here. */
function suggest() {
  const g = shown();
  if (!myTurn(g)) return;
  const m = chooseMove(g, ui.me);
  const top = G.upcard(g);
  ui.hintCard = null;
  switch (m.type) {
    case 'takeUpcard': case 'drawDiscard': ui.hint = `Take the ${label(top)} from the pile.`; break;
    case 'passUpcard': ui.hint = `Pass on the ${label(top)}.`; break;
    case 'drawStock': ui.hint = 'Draw from the stock.'; break;
    case 'discard': ui.hint = `Throw the ${label(m.card)}.`; ui.hintCard = m.card; break;
    case 'knock': {
      const d = deadwoodCount(best(g.hands[ui.me].filter((x) => x !== m.card)));
      ui.hint = d === 0 ? `Go gin: throw the ${label(m.card)}!` : `Knock with ${d}: throw the ${label(m.card)}.`;
      ui.hintCard = m.card;
    }
  }
  render();
}

function continueAfterHand() {
  const g = shown();
  send({ type: 'continue', seat: ui.me, hand: g.handNumber });
}

// MARK: What changed: sounds, banners, the stats

function update() {
  const g = shown(), old = ui.prev, now = Date.now();
  const newGame = old && (g.history.length < old.history.length || (old.phase === 'gameOver' && g.phase !== 'gameOver'));
  if (!old || old.handNumber !== g.handNumber || newGame) {
    if (old) playSound('deal');
    ui.holdResultUntil = 0; ui.hint = null; ui.hintCard = null; ui.pending = null; ui.knocking = false; ui.showFinal = false;
  } else if (g.discards.length !== old.discards.length || g.hands[0].length !== old.hands[0].length || g.hands[1].length !== old.hands[1].length) {
    playSound('snap');
  }
  if (g.phase !== 'discarding' || g.turn !== ui.me) { ui.pending = null; ui.knocking = false; }

  // What the other player just did, when it isn't obvious from the table.
  const opp = 1 - ui.me;
  if (old && !newGame && old.handNumber === g.handNumber && g.lastMover === opp && g.lastMove && !['handOver', 'gameOver'].includes(g.phase) &&
      (old.discards.join() !== g.discards.join() || old.passedUpcard.join() !== g.passedUpcard.join())) {
    if (['takeUpcard', 'drawDiscard'].includes(g.lastMove.type) && old.discards.length) {
      showBanner({ title: `${opponentName()} took the ${label(old.discards[old.discards.length - 1])}`, player: opp });
    } else if (g.lastMove.type === 'passUpcard') showBanner({ title: `${opponentName()} passed`, player: opp });
  }

  // The hand just ended.
  if (old && g.result && (!old.result || old.handNumber !== g.handNumber) && !newGame) {
    const r = g.result, knocker = r.knocker !== null ? labelOf(r.knocker) : '';
    const banner = r.kind === 'gin' ? { title: 'Gin!', detail: knocker, player: r.knocker }
      : r.kind === 'knock' ? { title: 'Knock!', detail: knocker, player: r.knocker }
      : r.kind === 'undercut' ? { title: 'Undercut!', detail: `${labelOf(r.winner)} beat the knock`, player: r.winner }
      : { title: 'No one knocked', detail: 'The hand is a draw', player: null };
    if (r.kind !== 'draw') playSound('knock');
    showBanner({ ...banner, big: true }, params.has('fast') ? 100 : RESULT_HOLD + 200);
    ui.holdResultUntil = now + (params.has('fast') ? 0 : RESULT_HOLD);
    redrawAt(ui.holdResultUntil);
  }

  if (g.phase !== 'gameOver') ui.recorded = false;
  else if (!ui.recorded && old) {
    ui.recorded = true;
    const won = g.winner === ui.me, kind = stats[isOnline() ? 'online' : 'computer'];
    if (!params.has('autoplay')) {
      kind[won ? 'won' : 'lost'] += 1;
      if (won && G.finalScore(g).shutout) kind.shutouts += 1;
      store('gin.stats', stats);
    }
    if (won) playSound('fanfare', RESULT_HOLD);
  }
  ui.prev = JSON.parse(JSON.stringify(g));
  render();
}

function showBanner(b, ms = 2200) {
  ui.banner = { ...b, until: Date.now() + ms, id: Math.random() };
  redrawAt(ui.banner.until);
}

function redrawAt(time) {
  later.push(setTimeout(() => { if (state) render(); }, Math.max(0, time - Date.now()) + 20));
}

// MARK: The table

function sizes() {
  const w = document.documentElement.clientWidth, h = document.documentElement.clientHeight;
  const sideways = w > h && h < 500;
  const col = Math.min(w, 1000) - 24;
  return {
    sideways,
    hand: Math.floor(Math.min(col / 8.2, 92, sideways ? h / 4.3 : Infinity, (h - 300) / 2.1)),
    pile: Math.floor(Math.min(w / 4.6, h / (sideways ? 6.8 : 5.6), 120)),
    opp: sideways ? 30 : Math.floor(Math.min(Math.min(w / 4.6, h / 5.6, 120) * 0.55, w > 700 ? 64 : 54)),
  };
}

function render() {
  if (!state) return;
  const g = shown(), me = ui.me, opp = 1 - me, now = Date.now();
  const size = sizes();
  const screen = el('div', 'screen');
  const table = el('div', 'table' + (size.sideways ? ' sideways' : ''));
  table.style.setProperty('--hand-w', size.hand + 'px');
  table.style.setProperty('--pile-w', size.pile + 'px');
  table.style.setProperty('--opp-w', size.opp + 'px');
  if (isOnline() && !host.connected) table.appendChild(el('div', 'banner-line', 'Connection lost — reconnecting…'));

  // Top: my score, the hand, the menu; then the opponent.
  const top = el('div', 'topbar');
  top.appendChild(scoreChip(me, g));
  top.appendChild(el('div', 'center', `<b>Hand ${g.handNumber + 1}</b><small>Game to ${G.TARGET}</small>`));
  const menu = button('•••', 'menu', showMenu);
  menu.setAttribute('aria-label', 'Game menu');
  top.appendChild(menu);
  const them = el('div', 'opponent');
  them.appendChild(scoreChip(opp, g));
  const fan = el('div', 'fan-backs');
  g.hands[opp].forEach((_, i) => { const b = backEl(); b.style.left = `calc(var(--opp-w) * 0.28 * ${i})`; fan.appendChild(b); });
  them.appendChild(fan);
  them.appendChild(el('div', 'spacer'));
  if (g.turn === opp && ['upcard', 'drawing', 'discarding'].includes(g.phase)) them.appendChild(el('div', 'dots', '<i></i><i></i><i></i>'));

  // The stock and the pile.
  const mine = myTurn(g);
  const piles = el('div', 'piles');
  const stock = el('div', 'pile');
  const stack = el('button', 'stack' + (mine && g.phase === 'drawing' ? ' glow' : ''));
  stack.setAttribute('aria-label', 'Draw from the stock');
  for (let i = 0; i < Math.min(4, Math.max(G.stockCount(g), 1)); i++) { const b = backEl(); b.style.transform = `translate(${-i * 1.5}px, ${-i * 1.5}px)`; stack.appendChild(b); }
  stack.onclick = tapStock;
  stock.append(stack, el('div', 'caption', `Stock · ${G.stockCount(g)}`));
  const pile = el('div', 'pile');
  const discards = el('button', 'stack' + (mine && (g.phase === 'upcard' || (g.phase === 'drawing' && !g.mustDrawStock)) ? ' glow' : ''));
  if (g.discards.length > 1) { const under = cardEl(g.discards[g.discards.length - 2]); under.classList.add('under'); discards.appendChild(under); }
  const topCard = G.upcard(g);
  if (topCard !== null) {
    const c = cardEl(topCard);
    if (ui.lastTop !== topCard) c.classList.add('arrive');
    discards.appendChild(c);
  } else discards.appendChild(el('div', 'slot'));
  ui.lastTop = topCard;
  discards.setAttribute('aria-label', topCard !== null ? `Take the ${label(topCard)} from the pile` : 'The discard pile');
  discards.onclick = tapPile;
  pile.append(discards, el('div', 'caption', g.phase === 'upcard' ? 'Upcard' : 'Discards'));
  piles.append(stock, pile);
  if (ui.banner && now < ui.banner.until) piles.appendChild(bannerEl(ui.banner));

  const status = statusArea(g);
  const hand = handEl(g);
  if (size.sideways) {
    const row = el('div', 'top-row');
    row.append(top, them);
    table.append(row, piles, status, hand);
  } else table.append(top, them, piles, status, hand);
  screen.appendChild(table);

  // Overlays. The same one as last time doesn't fade in again.
  let overlay = null, key = null;
  if (state.paused && state.paused.seat !== me) { overlay = pausedPanel(); key = 'paused'; }
  else if ((g.phase === 'handOver' || g.phase === 'gameOver') && now >= ui.holdResultUntil) {
    overlay = ui.showFinal ? gameOverPanel(g) : resultPanel(g);
    key = `${ui.showFinal ? 'final' : 'result'}:${g.handNumber}`;
  }
  if (overlay) {
    if (key === ui.overlayKey) overlay.classList.add('still');
    screen.appendChild(overlay);
  }
  ui.overlayKey = key;
  const old = app.querySelector(':scope > .screen');
  if (old) old.replaceWith(screen);
  else { app.innerHTML = ''; app.appendChild(screen); }
}

function scoreChip(seat, g) {
  const chip = el('div', 'chip');
  const boxes = g.handsWon[seat];
  const tags = [g.dealer === seat ? '<small class="dealer">Dealer</small>' : '', boxes ? `<small>${boxes} box${boxes === 1 ? '' : 'es'}</small>` : ''].join('');
  chip.innerHTML = `<span class="peg-dot" style="background:${seat === ui.me ? MY_COLOR : THEIR_COLOR}"></span>
    <span class="who"><b>${esc(state.seats[seat].name)}</b>${tags ? `<span class="tags">${tags}</span>` : ''}</span>
    <span class="score">${g.scores[seat]}</span>`;
  return chip;
}

function bannerEl(b) {
  const color = b.player === null || b.player === undefined ? 'neutral' : b.player === ui.me ? 'mine' : 'theirs';
  return el('div', `banner ${color}${b.big ? ' big' : ''}`, `<b>${b.title}</b>${b.detail ? `<small>${b.detail}</small>` : ''}`);
}

function statusText(g) {
  const theirTurn = isOnline() ? `${opponentName()}’s turn` : `${opponentName()} is playing…`;
  switch (g.phase) {
    case 'upcard': return g.turn === ui.me ? `Take the ${label(G.upcard(g))}, or pass` : theirTurn;
    case 'drawing': return g.turn === ui.me ? (g.mustDrawStock ? 'Draw from the stock' : 'Draw from the stock or the pile') : theirTurn;
    case 'discarding':
      if (g.turn !== ui.me) return theirTurn;
      if (ui.pending !== null) return 'Tap it again to confirm';
      if (ui.knocking) return G.ginDiscards(g, ui.me).length ? 'Pick a card to throw face down for gin' : 'Pick a card to throw face down';
      return 'Pick a card to discard';
    default: return '';
  }
}

function statusArea(g) {
  const area = el('div', 'status');
  const row = el('div', 'row');
  const mine = myTurn(g);
  row.appendChild(el('div', 'text', statusText(g)));
  if (mine && g.phase === 'upcard') row.append(button('Take It', 'primary', tapPile), button('Pass', 'ghost', () => perform('passUpcard')));
  const knockable = mine && g.phase === 'discarding' ? G.knockingDiscards(g, ui.me) : [];
  const gins = mine && g.phase === 'discarding' ? G.ginDiscards(g, ui.me) : [];
  if (mine && g.phase === 'discarding' && ui.pending !== null) {
    const c = ui.pending;
    const text = ui.knocking ? (gins.includes(c) ? `Gin with ${label(c)}` : `Knock with ${label(c)}`) : `Discard ${label(c)}`;
    row.appendChild(button(text, ui.knocking ? 'green' : 'primary', confirmDiscard));
  }
  if (knockable.length) {
    const lowest = Math.min(...knockable.map((c) => deadwoodCount(best(g.hands[ui.me].filter((x) => x !== c)))));
    row.appendChild(button(ui.knocking ? 'Cancel' : gins.length ? 'Gin!' : `Knock (${lowest})`, ui.knocking ? 'gray' : gins.length ? 'green' : 'primary', toggleKnocking));
  }
  if (mine && settings.hints && !ui.knocking) row.appendChild(button('Suggest', 'ghost', suggest));
  area.appendChild(row);
  const info = el('div', 'row small');
  const deadwood = deadwoodCount(G.arrangement(g, ui.me));
  info.appendChild(el('div', 'deadwood ' + (deadwood === 0 ? 'gin' : deadwood <= G.KNOCK_LIMIT ? 'ok' : ''), `${deadwood <= G.KNOCK_LIMIT ? '✓ ' : ''}Deadwood ${deadwood}`));
  info.appendChild(button(settings.bySuit ? 'By Suit ⇅' : 'By Number ⇅', 'ghost small', () => { settings.bySuit = !settings.bySuit; saveSettings(); render(); }));
  area.appendChild(info);
  if (ui.hint) area.appendChild(el('div', 'hint', esc(ui.hint)));
  return area;
}

/** My hand, laid out in its melds (each with a gold bar under it) and then the deadwood. */
function handEl(g) {
  const row = el('div', 'hand');
  const arr = G.arrangement(g, ui.me);
  const melds = arr.melds.map((m) => sortCards(m.cards)).sort((a, b) => (sortCards([a[0], b[0]])[0] === a[0] ? -1 : 1));
  const groups = [...melds, sortCards(arr.deadwood)];
  const discarding = g.phase === 'discarding' && g.turn === ui.me;
  const knockable = ui.knocking ? G.knockingDiscards(g, ui.me) : [];
  groups.forEach((group, i) => {
    if (!group.length) return;
    const box = el('div', 'group' + (i < melds.length ? ' meld' : ''));
    for (const c of group) {
      const e = cardEl(c);
      const picked = c === ui.pending;
      if (picked) e.classList.add('picked');
      else if (ui.knocking ? knockable.includes(c) : c === ui.hintCard) e.classList.add('raised');
      if (ui.knocking && !knockable.includes(c)) e.classList.add('dim');
      if (c === g.takenFromPile) e.classList.add('taken');
      if (discarding) e.classList.add('tappable');
      e.onclick = () => tapCard(c);
      box.appendChild(e);
    }
    row.appendChild(box);
  });
  return row;
}

// MARK: The hand's result and the final score

function resultPanel(g) {
  const r = g.result;
  if (!r) return gameOverPanel(g);
  const order = r.knocker !== null ? [r.knocker, 1 - r.knocker] : [ui.me, 1 - ui.me];
  const body = el('div', 'result');
  for (const seat of order) body.appendChild(laidDown(seat, r));
  body.appendChild(el('div', 'why', explanation(r)));
  if (r.winner !== null) body.appendChild(el('div', 'won ' + (r.winner === ui.me ? 'mine' : 'theirs'), `+${r.points} for ${labelOf(r.winner)}`));
  const running = el('div', 'running');
  for (const seat of [ui.me, 1 - ui.me]) {
    const n = g.handsWon[seat];
    running.appendChild(el('div', '', `<small>${labelOf(seat)}</small><b class="${seat === ui.me ? 'mine' : 'theirs'}">${g.scores[seat]}</b><small>${n} hand${n === 1 ? '' : 's'} won</small>`));
  }
  body.appendChild(running);
  const title = r.kind === 'gin' ? 'Gin!' : r.kind === 'knock' ? `${labelOf(r.knocker)} knocked` : r.kind === 'undercut' ? 'Undercut!' : 'A drawn hand';
  return dialog(title, body, [continueArea(g)]);
}

function laidDown(seat, r) {
  const arr = r.arrangements[seat];
  const d = deadwoodCount(arr);
  const role = seat === r.knocker ? (r.kind === 'gin' ? 'Gin' : `Knocked with ${d}`) : `Deadwood ${d}`;
  const box = el('div', 'laid');
  box.appendChild(el('div', 'who', `<span class="peg-dot" style="background:${seat === ui.me ? MY_COLOR : THEIR_COLOR}"></span><b>${labelOf(seat)}</b><span>${role}</span>`));
  const cards = el('div', 'cards');
  const group = (list, cls, tag) => {
    const gEl = el('div', 'group ' + cls);
    if (tag) gEl.appendChild(el('div', 'tag', tag));
    for (const c of list) gEl.appendChild(cardEl(c));
    cards.appendChild(gEl);
  };
  for (const m of arr.melds) group(m.cards, 'meld');
  const layoffs = seat === r.knocker ? [] : r.layoffs;
  if (layoffs.length) group(layoffs, 'layoff', 'LAID OFF');
  if (arr.deadwood.length) group(arr.deadwood, 'dead');
  box.appendChild(cards);
  return box;
}

/** Why it scored what it did, in words. */
function explanation(r) {
  const kd = r.knocker !== null ? deadwoodCount(r.arrangements[r.knocker]) : 0;
  const defender = r.knocker !== null ? 1 - r.knocker : null;
  const dd = defender !== null ? deadwoodCount(r.arrangements[defender]) : 0;
  switch (r.kind) {
    case 'gin': return `Gin scores the other hand’s deadwood (${dd}) plus a ${G.GIN_BONUS} bonus. No lay-offs against gin.`;
    case 'knock': return `${dd} − ${kd} = ${r.points}.`;
    case 'undercut': return `${labelOf(defender)} had ${dd}, no more than the knock’s ${kd}: ${kd - dd} + ${G.UNDERCUT_BONUS} undercut bonus.`;
    default: return `The stock ran down to ${G.DEAD_STOCK} cards without a knock. No score; the same dealer deals again.`;
  }
}

/** Against a person, Next Hand waits for both players (or 30 seconds after the first). */
function continueArea(g) {
  const area = el('div', 'continue');
  if (g.phase === 'gameOver') {
    area.appendChild(button('Final Score', 'primary big', () => { ui.showFinal = true; render(); }));
  } else if ((g.continued || []).includes(ui.me)) {
    const left = Math.max(0, Math.ceil(((g.continueDeadline ?? Date.now()) - Date.now()) / 1000));
    area.appendChild(el('div', 'pill', `Waiting for ${opponentName()}… ${left}`));
    redrawAt(Date.now() + 1000);
  } else {
    area.appendChild(button('Next Hand', 'primary big', continueAfterHand));
    if ((g.continued || []).includes(1 - ui.me)) area.appendChild(el('div', 'ready', `✓ ${opponentName()} is ready`));
  }
  return area;
}

function gameOverPanel(g) {
  const me = ui.me, opp = 1 - me, won = g.winner === me;
  const f = G.finalScore(g);
  const body = el('div', 'final');
  if (f) {
    if (f.shutout) body.appendChild(el('div', 'shutout', won ? 'A shutout! Your score is doubled.' : 'Shut out!'));
    const row = (name, a, b) => `<tr><td>${name}</td><td>${a}</td><td>${b}</td></tr>`;
    body.appendChild(el('table', 'totals', `<tr><th></th><th>You</th><th>${opponentName()}</th></tr>` +
      row('Points', f.points[me], f.points[opp]) +
      row(`Boxes (${G.BOX_BONUS} per hand won)`, f.boxes[me], f.boxes[opp]) +
      row('Game bonus', f.gameBonus[me], f.gameBonus[opp]) +
      (f.shutout ? row('Shutout', g.winner === me ? '× 2' : '', g.winner === opp ? '× 2' : '') : '') +
      `<tr class="total"><td>Total</td><td>${f.totals[me]}</td><td>${f.totals[opp]}</td></tr>`));
    body.appendChild(el('div', 'margin', `${won ? 'You win' : `${opponentName()} wins`} by ${f.margin}`));
  }
  body.appendChild(el('div', 'note', recordText()));
  return dialog(won ? 'You win!' : `${opponentName()} wins`, body, [
    button('Play Again', 'primary', () => send({ type: 'newGame' })),
    button('Leave', '', leaveGame),
  ]);
}

function pausedPanel() {
  const away = state.paused;
  return dialog('Paused', `Waiting for <b>${esc(away.name)}</b> to come back… They reopen the link, or tap Back to Game on the start screen.`,
    [button('Leave for Now', '', leave)]);
}

// MARK: Menu, settings, statistics

function leaveGame() {
  // Online, keep the code so Back to Game works — unless the game is over.
  if (isOnline() && state && state.game.phase === 'gameOver') lastOnline.clear();
  leave();
}

function showMenu() {
  const online = isOnline();
  popup('Menu', online ? `Online game <b>${host.code}</b>` : null, [
    ['New Game', '', () => confirmThen('New Game?', online ? 'This starts the game over for you both.' : 'This game’s score will be lost.', 'New Game', () => send({ type: 'newGame' }))],
    ['Statistics', '', showStats],
    ['Settings', '', () => showSettings(render)],
    [online ? 'Leave for Now' : 'Leave Game', '', leaveGame],
    ['Close', 'primary'],
  ]);
}

function showSettings(after) {
  const form = el('div', 'settings');
  form.innerHTML = `
    ${state ? '' : '<label>Your name <input class="text" id="name" maxlength="16" autocomplete="nickname"></label>'}
    <label>Show the Suggest button <input type="checkbox" id="hints" ${settings.hints ? 'checked' : ''}></label>
    <label>Sort my cards <select id="sort"><option value="number" ${settings.bySuit ? '' : 'selected'}>By Number</option><option value="suit" ${settings.bySuit ? 'selected' : ''}>By Suit</option></select></label>
    <label>Highest card on the left <input type="checkbox" id="high" ${settings.highFirst ? 'checked' : ''}></label>
    <label>Large card letters <input type="checkbox" id="large" ${settings.largePrint ? 'checked' : ''}></label>
    <label>Sounds <input type="checkbox" id="sounds" ${settings.sounds ? 'checked' : ''}></label>
    <label>Card back <select id="back">${['red', 'green', 'blue', 'black'].map((c) => `<option value="${c}" ${settings.back === c ? 'selected' : ''}>${c[0].toUpperCase() + c.slice(1)}</option>`).join('')}</select></label>`;
  const name = form.querySelector('#name');
  if (name) name.value = settings.name;
  const done = () => {
    if (name && name.value.trim()) settings.name = name.value.trim().slice(0, 16);
    settings.hints = form.querySelector('#hints').checked;
    settings.bySuit = form.querySelector('#sort').value === 'suit';
    settings.highFirst = form.querySelector('#high').checked;
    settings.largePrint = form.querySelector('#large').checked;
    settings.sounds = form.querySelector('#sounds').checked;
    settings.back = form.querySelector('#back').value;
    saveSettings();
    after?.();
  };
  popup('Settings', form, [['Done', 'primary', done]], done);     // Closing any way keeps the changes.
}

function showStats() {
  const row = (title, s) => `<tr><td>${title}</td><td>${s.won}</td><td>${s.lost}</td><td>${s.shutouts}</td></tr>`;
  const body = el('div', '', `<table class="stats"><tr><th></th><th>Won</th><th>Lost</th><th>Shutouts</th></tr>${row('vs the Computer', stats.computer)}${row('vs Friends', stats.online)}</table><div class="note">Kept on this device.</div>`);
  popup('Statistics', body, [['Done', 'primary']]);
}

// MARK: Start

let resizeFrame = 0;
window.addEventListener('resize', () => { cancelAnimationFrame(resizeFrame); resizeFrame = requestAnimationFrame(render); });

if (params.get('name')) { settings.name = params.get('name').slice(0, 16); saveSettings(); }
if (params.has('fast')) Object.assign(PACE, { draw: 30, discard: 40, autoplayHand: 60 });
const code = params.get('g') || params.get('newgame');
if (code && onlineAvailable()) {
  const go = () => (params.get('newgame') ? withTable(OnlineTable.create(myName(), onTableUpdate, code)) : joinGame(code));
  // Someone opening a shared link for the first time: their name before their seat.
  if (settings.name) go(); else askName(go);
} else if (params.has('play') || params.has('autoplay')) playComputer();
else showLobby();
