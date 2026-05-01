# Bookup

Bookup is a GPL repertoire trainer built from your real games. It imports your public Chess.com archive, learns the opening positions and branches you actually reach, uses Stockfish plus the Lichess opening database to study those positions, and lets you work through lines on a legal-move board.

## What Bookup Does

- imports public Chess.com games by username and time control
- imports saved PGN text when you want a fully local/manual source
- supports `Import all public games`
- caches imported games and full analyzed repertoires locally so repeat loads are much faster
- builds a repertoire map from repeated positions you actually reach
- groups transpositions by position instead of only by opening label
- shows a repertoire health dashboard with coverage, due load, weak branches, and known lines
- scores line memory so fragile, building, and strong branches are separated
- detects opening drift by comparing recent first moves with your long-term imported repertoire
- exports a compact preparation pack with focus lines, common replies, and maintenance lines
- shows local engine/profile cache health so repeat analysis is easier to trust
- generates a short study plan from due lines, fragile memory scores, common replies, and new branches
- shows a confidence graph so weak, building, stable, and strong lines are visible at a glance
- proposes drift fixes when your recent first moves stop matching your longer-term repertoire
- explains import speed with indexed positions, analyzed positions, skipped positions, and cache notes
- uses Stockfish for best moves, candidate lines, eval, coach explanations, and move classifications
- uses the Lichess opening database when available for practical move popularity and common replies
- tracks live book state so `Book` labels stop once a line leaves the opening/repertoire context
- reuses cached Stockfish position analysis for repeated FEN/settings combinations instead of reanalyzing the same position
- builds a practical theory tree from imported games, split by games where you played White or Black
- generates on-demand theory lines from the current position or after a move you want to test
- suggests one-click theory seeds from common replies and due-line repairs
- builds database-weighted response drills so common replies become trainable lines
- includes an opponent simulator, pre-move quiz cards, smart retry deck, blunder trap finder, and repertoire export
- tracks repeated mistake heatmap squares, mistake timelines, and spaced-review buckets
- filters out lines you already know well enough so the active queue stays focused
- explains every due/new queue item with the repeated-miss evidence, frequency, review state, and engine/database factors that put it there
- classifies moves with Chess.com-style labels such as `Book`, `Best`, `Excellent`, `Great`, `Brilliant`, `Mistake`, and `Blunder`
- runs as a Windows desktop app instead of a plain browser tab

## Workspaces

- `Setup`
  Import games, configure the engine, add a Lichess token, and build or reload your repertoire.

- `Repertoire Map`
  See health, study plan, memory scores, confidence graph, opening drift, drift fixes, cache health, preparation packs, import speed, repeated repertoire positions, transpositions, and branches you actually reach. Compare your repeated move with the recommended move and open exact lines to work on.

- `Needs Work`
  Focus on repeated repertoire mistakes, due lines, fresh lines, queue explainers, suggested repertoire updates, mistake heatmap squares, mistake timelines, spaced-review buckets, smart retry cards, and pre-move quizzes.

- `Study Lines`
  Work through a line on the board with:
  - a live eval bar
  - Stockfish candidate lines
  - Lichess/database moves from the current position
  - copy buttons for the current FEN and played PGN path
  - move classifications
  - a move trail
  - live Stockfish settings for depth, MultiPV, threads, hash, and engine path

- `Theory`
  Explore your imported-game move tree, prepare against common database replies, run opponent-simulator scenarios, inspect blunder traps, export your repertoire, and ask Stockfish to generate the next best moves from the current board position.

- `Review`
  Revisit repeated positions that still need correction.

## Study Lines

The `Study Lines` workspace is the main live-analysis surface.

It combines:

- the central training board
- a live evaluation rail
- top Stockfish lines for the current position
- practical Lichess/database moves from that same position
- a database-only fallback refresh when Stockfish is unavailable or still loading
- move classifications for the move played and the recommended move
- live board arrows for ideas and threats
- in-tab Stockfish settings so you can tune analysis without leaving the study view

The board is still repertoire-first:

- Bookup starts from a stored line root
- it plays the lead-in automatically until your turn
- at decision points, it can classify what you actually play
- it still shows the recommended repertoire move and continuation
- engine and database side-panel rows can be played directly onto the board for quick “what if?” study
- exact branches can be saved as your repertoire move for a position

## Imported Game Tree Map

The `Theory` workspace includes a tree map built from your imported games only.

It includes:

- separate trees for games where you played White and games where you played Black
- Bookup-themed branch cards with weighted first moves, branch percentages, and opening labels
- clear labels for `your move` versus `opponent reply`
- a deep branch explorer under the visual map
- click-to-load nodes that open the exact resulting FEN on the Study Lines analysis board

## Theory

The `Theory` workspace has seven study tools:

- `Imported Games Theory Tree`
  Shows the move tree from your imported games only. Click any branch card to open that exact position on the Study Lines board.

- `Theory Generator`
  Uses the current Study Lines board position. You can optionally enter a UCI move such as `e2e4`, then generate the next 10 best moves, or any value from 1 to 30, using the saved Stockfish settings.

- `Theory Presets`
  Offers one-click seeds from due lines and common replies so you can extend the line without typing UCI.

- `Response Builder`
  Uses repeated repertoire lines plus database/common-reply context to create practical “if they play this, answer with this” training cards.

- `Opponent Simulator`
  Turns common database replies into practice scenarios.

- `Blunder Trap Finder`
  Highlights common replies or repeated lines where the punishment is concrete enough to rehearse.

- `Repertoire Export`
  Downloads a local text export of prepared lines and first-move tree data.

## Inputs

- `Chess.com username`
  Required to import your public games.

- `Time classes`
  Use `all` for all public games, or a comma-separated list such as `rapid,blitz`.

- `Max games`
  Use `0` to import all available public games.

- `Lichess token`
  Optional. Enables richer live Lichess opening-database responses in study and repertoire views.

- `Stockfish path`
  Required when running from source unless the bundled engine is already available locally.

- `PGN text`
  Optional. Paste saved PGNs in Setup to build the same local repertoire and theory tree without fetching from Chess.com.

## Run From Source

```powershell
python -m pip install -r requirements.txt
python main.py
```

## Desktop EXE

The packaged Windows app runs from the top-level Bookup folder:

```powershell
.\Bookup.exe
```

After packaging, the top-level folder keeps:

- `Bookup.exe`
- `_internal\`
  Runtime assets, templates, board pieces, and the bundled Stockfish executable
- `config.json`
  Saved local settings if present
- `bookup_data\`
  Local caches for imported games, analyzed repertoires, and review progress

## Build The EXE

To rebuild the desktop app into the clean top-level layout:

```powershell
python package.py
```

That command recreates:

- `Bookup.exe`
- `_internal\`

without restoring the old `dist\Bookup\...` layout.

## Local Data

Bookup stores local state in `bookup_data\` so it can reopen faster and remember your training work.

That includes:

- imported Chess.com games
- imported PGN games from manual local imports
- cached analyzed repertoires keyed by request/settings
- imported-game move-tree payloads
- health dashboard, heatmap, mistake timeline, response-builder, and transposition payloads inside the saved profile snapshot
- study plan, confidence graph, smart retry, pre-move quiz, opponent simulator, blunder traps, and repertoire export payloads
- snapshot state for the latest profile
- training progress and review stats

If you rerun the exact same import and analysis settings, Bookup should load from cache instead of redoing the full work.

## Notes

- Leave `Time classes` as `all` for the full public archive.
- Use `Max games = 0` to import all public games.
- Add a Lichess token if you want richer database move coverage in `Study Lines`.
- Exact first-time loads can still take longer because Stockfish is doing real repertoire analysis.
- Repeat loads of the same request should be much faster because Bookup now reuses cached games and cached analyzed profiles.
- The Lichess database panel can update separately from Stockfish, so database moves are still useful when engine analysis is slow.
- PGN import is local and uses the same analysis/cache pipeline as Chess.com imports.

## Current Direction

Bookup is aimed at repertoire study rather than generic game review.

The current product direction is:

- positions and branches you actually reach
- practical opponent replies from the database
- engine-backed candidate lines and eval
- move classifications on the board and in the side panels
- health, heatmap, mistake timeline, review schedule, and response-builder surfaces that explain what to study next
- study plan, confidence graph, smart retry, pre-move quiz, opponent simulator, trap finder, and export tools that turn the repertoire into a real workflow
- a legal-move study board that helps you work on the lines that matter most

## Next Improvements

- background analysis for new positions before you open them
- stronger book-move detection from live opening context
- tighter drag-and-drop polish and board-interaction cleanup
- richer theory-tree filtering by side, result, and time control
- one-click “train against database” sessions that repeatedly choose common replies
