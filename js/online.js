// Playing a friend through Firebase (the same free project as Hearts and Cribbage:
// Realtime Database + anonymous sign-in). A game lives at /tables/gin-CODE:
//   meta      { hostUid, epoch, started, created } — epoch goes up each time the host changes
//   seats     [ { kind: 'person' | 'open', name, uid } ] ×2
//   state     the whole table state as JSON (written only by the host)
//   moves     moves the other player sends ({ uid, move }); the host applies and deletes them
//   presence  { uid: true } — Firebase removes an entry the moment that browser drops
// The host's browser runs the game. The game starts the moment the second person sits
// down. If either drops, the game waits until they're back (same browser = same seat);
// if the host is the one who dropped, the other player takes over hosting. The host
// stamps the state with its epoch, so an old host waking up can't write over the game.

import { firebaseConfig } from './firebase-config.js';
import { applyMove, newTableState, nextHostStep } from './table.js';

const SDK = 'https://www.gstatic.com/firebasejs/10.12.2/';
export const onlineAvailable = () => Boolean(firebaseConfig && firebaseConfig.apiKey);

let fb = null;      // { db, uid, api }

async function connect() {
  if (fb) return fb;
  const [appMod, authMod, dbMod] = await Promise.all([
    import(SDK + 'firebase-app.js'), import(SDK + 'firebase-auth.js'), import(SDK + 'firebase-database.js'),
  ]);
  const app = appMod.initializeApp(firebaseConfig);
  const auth = authMod.getAuth(app);
  // Anonymous sign-in: no account; the same browser keeps the same id, which is how a
  // dropped player gets their own seat back.
  if (!auth.currentUser) await authMod.signInAnonymously(auth);
  fb = { db: dbMod.getDatabase(app), uid: auth.currentUser.uid, api: dbMod };
  return fb;
}

const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';       // No I or O (they look like 1 and 0).
const newCode = () => Array.from({ length: 4 }, () => LETTERS[Math.floor(Math.random() * LETTERS.length)]).join('');
const path = (code) => `tables/gin-${code}`;

/** One game, seen from this browser. Calls `onUpdate()` whenever anything changes. */
export class OnlineTable {
  constructor(code, onUpdate) {
    this.code = code;
    this.onUpdate = onUpdate;
    this.meta = null; this.seats = []; this.state = null; this.presence = {};
    this.unsubs = [];
    this.timer = null;
    this.isHost = false;
    this.epoch = 0;
    this.connected = true;
  }

  /** Starts a new game with me in the first seat. */
  static async create(name, onUpdate, wanted = null) {
    const { db, uid, api } = await connect();
    for (let tries = 0; tries < 20; tries++) {
      const code = tries === 0 && wanted ? wanted : newCode();
      const result = await api.runTransaction(api.ref(db, `${path(code)}/meta`),
        (meta) => (meta ? undefined : { hostUid: uid, epoch: 1, started: false, created: Date.now() }));
      if (!result.committed) continue;
      await api.set(api.ref(db, `${path(code)}/seats`), [{ kind: 'person', name, uid }, { kind: 'open' }]);
      const table = new OnlineTable(code, onUpdate);
      await table.listen();
      return table;
    }
    throw new Error('Could not make a game code — try again.');
  }

  /** Joins (or rejoins) a game by its code. */
  static async join(code, name, onUpdate) {
    const { db, uid, api } = await connect();
    code = code.toUpperCase();
    const meta = (await api.get(api.ref(db, `${path(code)}/meta`))).val();
    if (!meta) throw new Error(`There's no game ${code}.`);
    const result = await api.runTransaction(api.ref(db, `${path(code)}/seats`), (seats) => {
      if (!seats) return seats;
      if (seats.some((s) => s && s.uid === uid)) return seats;              // Rejoining my seat.
      const open = seats.findIndex((s) => s && s.kind === 'open');
      if (open < 0) return undefined;
      seats[open] = { kind: 'person', name, uid };
      return seats;
    });
    if (!result.committed || !result.snapshot.val().some((s) => s && s.uid === uid)) {
      throw new Error(`Game ${code} already has two players.`);
    }
    const table = new OnlineTable(code, onUpdate);
    await table.listen();
    return table;
  }

  get uid() { return fb.uid; }
  get mySeat() { return this.seats.findIndex((s) => s && s.uid === fb.uid); }
  get started() { return Boolean(this.meta && this.meta.started); }
  /** The other player's seat is empty, or they're away. */
  get opponentHere() { const o = this.seats[1 - this.mySeat]; return Boolean(o && o.uid && this.presence[o.uid]); }

  async listen() {
    const { db, uid, api } = fb;
    const base = path(this.code);
    // My presence: removed by Firebase itself if this browser disconnects.
    const me = api.ref(db, `${base}/presence/${uid}`);
    this.unsubs.push(api.onValue(api.ref(db, '.info/connected'), (snap) => {
      clearTimeout(this.offlineTimer);
      if (snap.val() === true) {
        api.onDisconnect(me).remove(); api.set(me, true);
        if (!this.connected) { this.connected = true; this.changed(); }
      } else {
        // Only say so if it lasts (it's briefly false while first connecting).
        this.offlineTimer = setTimeout(() => { this.connected = false; this.changed(); }, 2500);
      }
    }));
    this.unsubs.push(api.onValue(api.ref(db, `${base}/meta`), (s) => { this.meta = s.val(); this.roleChanged(); }));
    this.unsubs.push(api.onValue(api.ref(db, `${base}/seats`), (s) => { this.seats = s.val() || []; this.seatsChanged(); }));
    this.unsubs.push(api.onValue(api.ref(db, `${base}/presence`), (s) => { this.presence = s.val() || {}; this.presenceChanged(); }));
    this.unsubs.push(api.onValue(api.ref(db, `${base}/state`), (s) => {
      const json = s.val();
      if (!this.isHost) { this.state = json ? JSON.parse(json) : null; this.changed(); }
      else if (!this.state && json) { this.state = JSON.parse(json); this.checkPause(); this.hostStep(); this.changed(); }
    }));
    this.unsubs.push(api.onChildAdded(api.ref(db, `${base}/moves`), (s) => this.isHost && this.hostMove(s)));
  }

  changed() { this.onUpdate(); }

  // MARK: Being the host

  roleChanged() {
    const wasHost = this.isHost;
    this.isHost = Boolean(this.meta && this.meta.hostUid === fb.uid);
    if (this.isHost) this.epoch = this.meta.epoch || 1;
    if (this.isHost && !wasHost) {
      // Just became host (made the game, or took over): pick up any moves waiting.
      const { db, api } = fb;
      api.get(api.ref(db, `${path(this.code)}/moves`)).then((snap) => snap.forEach((m) => { this.hostMove(m); }));
      this.checkPause();
      this.hostStep();
    }
    this.seatsChanged();
  }

  /** The host deals as soon as both seats are taken. */
  seatsChanged() {
    if (this.isHost && this.meta && !this.meta.started && this.seats.length === 2 && this.seats.every((s) => s && s.kind === 'person')) {
      this.start();
    }
    this.changed();
  }

  presenceChanged() {
    const { db, api } = fb;
    // The host is gone: the other player takes over after a moment.
    if (this.meta && !this.presence[this.meta.hostUid] && this.presence[fb.uid] && this.mySeat >= 0) {
      clearTimeout(this.takeoverTimer);
      this.takeoverTimer = setTimeout(() => {
        if (!this.meta || this.presence[this.meta.hostUid]) return;
        api.runTransaction(api.ref(db, `${path(this.code)}/meta`), (meta) => {
          if (!meta || this.presence[meta.hostUid]) return undefined;
          meta.hostUid = fb.uid;
          meta.epoch = (meta.epoch || 1) + 1;
          return meta;
        });
      }, 4000);
    }
    if (this.isHost) this.checkPause();
    this.changed();
  }

  /** Wait while a player is away. */
  checkPause() {
    if (!this.state || !this.started) return;
    const away = this.seats.findIndex((s) => s && s.kind === 'person' && !this.presence[s.uid]);
    const paused = away >= 0 ? { seat: away, name: this.seats[away].name } : null;
    if (JSON.stringify(paused) !== JSON.stringify(this.state.paused ?? null)) { this.state.paused = paused; this.publish(); }
  }

  hostMove(snap) {
    if (!this.isHost) return;
    const { api } = fb;
    const { uid, move } = snap.val() || {};
    api.remove(snap.ref);
    if (!this.state || !move) return;
    // A player may only move for their own seat.
    const seat = this.seats.findIndex((s) => s && s.uid === uid);
    if ('seat' in move && move.seat !== seat) return;
    if (move.type === 'timeUp') return;
    if (applyMove(this.state, move)) this.publish();
  }

  publish() {
    if (!this.isHost) return;
    const { db, api } = fb;
    this.state.seats = this.seats.map((s) => ({ kind: 'person', name: s.name }));
    this.state.epoch = this.epoch;
    const json = JSON.stringify(this.state), epoch = this.epoch;
    api.runTransaction(api.ref(db, `${path(this.code)}/state`), (current) => {
      try { if (current && JSON.parse(current).epoch > epoch) return undefined; } catch {}
      return json;
    }, { applyLocally: false }).then((result) => {
      if (result.committed || !result.snapshot.val()) return;
      // A newer host has taken over: stop hosting and follow their game.
      this.isHost = false;
      clearTimeout(this.timer);
      this.state = JSON.parse(result.snapshot.val());
      this.changed();
    });
    this.changed();
    this.hostStep();
  }

  hostStep() {
    clearTimeout(this.timer);
    if (!this.isHost || !this.state) return;
    const step = nextHostStep(this.state);
    if (!step) return;
    const version = this.state.version;
    this.timer = setTimeout(() => {
      if (this.isHost && this.state.version === version && applyMove(this.state, step.move())) this.publish();
    }, step.delay);
  }

  async start() {
    if (!this.isHost || this.starting) return;
    this.starting = true;
    const { db, api } = fb;
    this.state = newTableState(this.seats.map((s) => ({ kind: 'person', name: s.name })));
    await api.update(api.ref(db, `${path(this.code)}/meta`), { started: true });
    this.publish();
  }

  // MARK: Moves from this browser

  send(move) {
    if (this.isHost) {
      if (applyMove(this.state, move)) this.publish();
      return;
    }
    const { db, uid, api } = fb;
    api.push(api.ref(db, `${path(this.code)}/moves`), { uid, move });
  }

  stop() {
    clearTimeout(this.timer); clearTimeout(this.takeoverTimer); clearTimeout(this.offlineTimer);
    this.unsubs.forEach((u) => u());
    const { db, uid, api } = fb;
    api.remove(api.ref(db, `${path(this.code)}/presence/${uid}`));
  }
}
