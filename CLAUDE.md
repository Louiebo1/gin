# Gin Rummy for the web

Plain JavaScript (ES modules, no build step, no Node) so it runs from any static host.
Started 2026-10-23 for Louie: the iPhone app (`~/code/ginrummy`) in a browser — play the
computer, or a friend anywhere with a 4-letter code. Built like `~/code/cribbage-web`
(same structure, same Firebase project as Hearts and Cribbage).

## Layout
- `js/cards.js` — cards as ints (suit*100+rank, ace low 1; ♣ ♦ ♠ ♥ display order).
- `js/melds.js` — the app's `Melds`: candidates, `best` (least deadwood; ties: fewer
  deadwood cards), `allMaximal`, `defend` (the defender's melds + lay-offs).
  Candidate order: sets by rank, then runs by suit (the app's order comes from a
  Dictionary, so it varies; it made no difference to any decision in the parity check).
- `js/game.js` — the app's `GinGame` (Louie's rules, 2026-10-18): first upcard (pone,
  then dealer, may take it or pass), draw then discard (not the card just taken), knock
  ≤ 10, gin +25 and no lay-offs, undercut 25 + difference, stock down to 2 = draw (same
  dealer again), 150 discards = draw, deal alternates, game to 100, boxes 25 per hand won,
  game bonus 100, shutout doubles. Moves are `{ type, card? }`; illegal ones throw.
- `js/computer.js` — the app's `ComputerPlayer` (take the upcard only for a meld or a
  knock; discard by deadwood − 0.6 × connections + 0.2 × danger; knock threshold 10/7/5/2
  as the stock runs down). When the app's computer changes, port it and rerun parity.
- `js/table.js` — table state, `applyMove`, `nextHostStep` (computer pacing as the app:
  0.64 s draws, 0.8 s discards; the 30-second Next Hand deadline between two people),
  `LocalHost`.
- `js/online.js` — Firebase at `/tables/gin-CODE` (the rules only open `/tables`); same
  scheme as Cribbage: two seats, deal when the second person sits down, pause on a drop,
  host takeover with the epoch guard.
- `js/sounds.js` — the app's synthesized snap, deal, knock and fanfare (Web Audio).
- `js/main.js` — screens: start (Continue Game, Back to Game CODE), friend (start/join),
  waiting room, table (stock and pile glow when you can take them; the hand laid out in
  melds with gold bars, then deadwood; tap a card, tap again or the button to throw;
  Knock (N) / Gin! mode; Suggest; By Number / By Suit), banners ("Computer took the 7♥",
  "Gin!"), the hand's result (both hands laid down, lay-offs tagged, the score explained),
  the final score, menu, settings, statistics (this device). localStorage `gin.settings`,
  `gin.stats`, `gin.local`, `gin.online`. Names from the other browser go through `esc()`.
  The table redraws inside `.screen`; dialogs opened on top are left alone.
- Not ported: nearby (Bluetooth) play, iCloud stats, the themes (Louie: not needed on the web).

## Test
- Rules: `jsc -m tests/engine.test.js` (melds, lay-offs, 30 computer games, Next Hand).
- Same as the app: `E=~/code/ginrummy/GinRummy/Engine; swiftc -O -module-name Parity
  $E/*.swift tests/parity/main.swift -o /tmp/gin_parity/parity &&
  /tmp/gin_parity/parity 200 > /tmp/gin_parity/hands.jsonl`, then
  `jsc tests/args.js -m tests/parity/parity.js -- /tmp/gin_parity/hands.jsonl`.
  2026-10-23: 500 games, 4,913 hands, 126,912 computer decisions and every result
  identical to the app (`jsc` = `/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc`).
- Page: serve with `Cache-Control: no-store`, headless Chrome with its own
  `--user-data-dir` (never Louie's). URL options: `?name=X`, `?play`, `?autoplay`,
  `?fast`, `?newgame=CODE`, `?g=CODE`. To click through, load the page in a same-origin
  iframe from a scratch driver page. Online: two simulators' Safari (iPhone
  `?newgame=TZxx`, iPad `?g=TZxx`); delete TZ* games after
  (`DELETE /tables/gin-TZxx.json?auth=…`, token from anonymous `accounts:signUp`).
  Verified 2026-10-23: 338 fast games through the page with no errors; an online game
  between the iPhone and iPad simulators through 3 hands.

## Deploy
GitHub Pages from `main` (repo Louiebo1/gin, public) → https://louiebo1.github.io/gin/.
`git push`; Pages rebuilds in about a minute. GitHub CLI: `~/bin/gh` (logged in as Louiebo1).

## Google sign-in (2026-10-28)
`js/account.js` is a copy of `~/code/cardgames-home/shared/account.js` — the same file in
every game; change it there and copy it to all of them. It owns the Firebase connection
(`online.js` gets the id from `playerId()`): anonymous unless the person signed in with
Google (the button on the start screen, `accountLobby()`; Sign Out in Settings). Signed in, the name and statistics live at
`/users/UID` (`name`, `email`, `games/<game id>`), private to that person; `main.js` calls
`syncGame(...)` at startup, `pushName` in `saveSettings`, `pushStats` when stats are saved.
