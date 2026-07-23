# Bookup

Bookup is a GPL repertoire trainer built from your real games. It imports your public Chess.com archive, learns the opening positions and branches you actually reach, uses Stockfish to study those positions, and lets you work through lines on a legal-move board.

## Website

Bookup includes a GitHub Pages website in `docs/`.

- The site root is the interactive Bookup Web app, not just a download page.
- Bookup Web has a real Chess.com public stats lookup for rapid, blitz, and bullet. It does not invent live ratings when the public API cannot be reached.
- The web and desktop editions share five focused areas: Setup, Repertoire, Train, Progress, and Smart Theory.
- Public games and PGN files are parsed locally into repertoire branches, review queues, health metrics, theory trees, and a legal-move training board.
- Browser analysis uses a responsive Stockfish worker pool with cached evaluations. Opening move history comes from the imported real-game corpus; Bookup does not call an online opening explorer.
- Settings, sessions, reviews, and repertoire summaries are stored in browser local storage. Bookup Web never requests a Lichess token; the desktop app can keep one for direct Study API actions in its ignored local configuration, which must never be committed.
- Repertoire PGN, Bookup JSON, and Smart Theory exports are generated entirely in the browser.
- The production site uses minified assets, native system fonts, lazy workspace rendering, idle-time persistence, cached analysis requests, and a precomputed repertoire position index.
- GitHub Pages deploys it from `.github/workflows/pages.yml`.
- The desktop build remains useful for native Stockfish executables, larger local caches, direct filesystem integrations, and NewChessnut database access.

Public URL for this repository:

```text
https://tetizz.github.io/Bookup/
```

GitHub Pages project paths follow the repository name. To use the lowercase URL `https://tetizz.github.io/bookup/`, rename the repository to lowercase `bookup` or publish the site from a user/organization Pages repo with a `/bookup/` folder.

Regenerate the optimized website assets after changing `docs/web-app.js` or `docs/styles.css`:

```text
build_web_assets.bat
```

## What Bookup Does

- imports public Chess.com games by username and time control
- imports saved PGN text when you want a fully local/manual source
- supports `Import all public games`
- caches imported games and full analyzed repertoires locally so repeat loads are much faster
- builds a repertoire map from repeated positions you actually reach
- groups transpositions by position instead of only by opening label
- shows a repertoire health dashboard with coverage, weak branches, and known lines
- scores line memory so fragile, building, and strong branches are separated
- detects opening drift by comparing recent first moves with your long-term imported repertoire
- charts rating progress, win/loss/draw record, score rate, win rate, and separate rapid/blitz/bullet time-control graphs across 30 days, 90 days, and all time
- exports a compact preparation pack with focus lines, common replies, and maintenance lines
- shows local engine/profile cache health so repeat analysis is easier to trust
- shows live Stockfish runtime stats during imports, including analyzed positions, positions per second, ETA, worker count, CPU budget, CPU usage, and memory usage
- generates a short study plan from repeated misses, common replies, and new branches
- shows a confidence graph so weak, building, stable, and strong lines are visible at a glance
- proposes drift fixes when your recent first moves stop matching your longer-term repertoire
- explains import speed with indexed positions, analyzed positions, skipped positions, and cache notes
- uses Stockfish for best moves, candidate lines, eval, coach explanations, and move classifications
- uses imported-game position history for practical move popularity and common replies
- tracks live book state so `Book` labels stop once a line leaves the opening/repertoire context
- reuses cached Stockfish position analysis for repeated FEN/settings combinations instead of reanalyzing the same position
- builds a practical theory tree from imported games, split by games where you played White or Black
- generates on-demand theory lines from the current position or after a move you want to test
- suggests one-click theory seeds from common replies and due-line repairs
- builds imported-game-weighted training positions so common replies become playable drills
- keeps the active training queue focused on repeated inaccurate, mistake, and blunder classifications
- explains each training position with its repeated-miss evidence and recommended correction
- classifies moves with Chess.com-style labels such as `Book`, `Best`, `Excellent`, `Great`, `Brilliant`, `Mistake`, and `Blunder`
- runs as a Windows desktop app instead of a plain browser tab

## Workspaces

- `Setup`
  Import public Chess.com games or saved PGN, configure analysis, and build or reload the local repertoire cache.

- `Repertoire`
  Inspect the positions, transpositions, first moves, imported-game tree, cache health, and branches you actually reach. Open any exact position for training or Smart Theory.

- `Train`
  Work through a correction queue on the board with:
  - a live eval bar
  - Stockfish candidate lines
  - imported moves from the current position
  - copy buttons for the current FEN and played PGN path
  - move classifications
  - a move trail
  - live Stockfish settings for depth, MultiPV, threads, hash, and engine path

- `Progress`
  Track rapid, blitz, and bullet ratings, results, recent form, measured accuracy, sessions, goal progress, projections, and time estimates. Manual values are clearly marked and are never presented as live Chess.com data.

- `Smart Theory`
  Generate a legal variation tree from the current board, a saved line, an imported game, or your repertoire. Known good moves remain in the line, Stockfish corrects weak moves, opponent replies stay legal, and each node keeps its source, evaluation, classification, and explanation.

## Study Lines

The `Train` workspace is the main live-analysis surface.

It combines:

- the central training board
- a live evaluation rail
- top Stockfish lines for the current position
- practical moves from imported-game position history
- an imported-history fallback while Stockfish is unavailable or still loading
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

The `Repertoire` workspace includes a tree map built from your imported games only.

It includes:

- separate trees for games where you played White and games where you played Black
- Bookup-themed branch cards with weighted first moves, branch percentages, and opening labels
- clear labels for `your move` versus `opponent reply`
- a deep branch explorer under the visual map
- click-to-load nodes that open the exact resulting FEN on the Study Lines analysis board

## Smart Theory

Smart Theory is a connected source-to-tree workflow rather than a random position generator:

- choose Current board, Saved line, Imported game, or My repertoire
- generate from the exact selected FEN
- follow known good moves and correct weak moves with Stockfish
- combine repertoire, imported-game history, and engine replies
- click any tree node to synchronize the board and explanation
- validate every parent, move, and resulting FEN before accepting a node
- cache completed analysis locally for offline reuse
- export a single nested PGN variation tree or the complete JSON schema

## Inputs

- `Chess.com username`
  Required to import your public games.

- `Time classes`
  Use `all` for all public games, or a comma-separated list such as `rapid,blitz`.

- `Max games`
  Use `0` to import all available public games.

- `Lichess token`
  Optional. Used only for direct Lichess Study API actions in the desktop app. It is never reused for opening analysis.

- `Stockfish path`
  Required when running from source unless the bundled engine is already available locally.

- `PGN text`
  Optional. Paste saved PGNs in Setup to build the same local repertoire and theory tree without fetching from Chess.com.

## Run From Source

```powershell
python -m pip install -r requirements.txt
python main.py
```

## Install The Windows Release

The easiest install path is the GitHub release installer:

1. Open `https://github.com/tetizz/Bookup/releases/latest`.
2. Download `Bookup-Setup-<version>.exe`.
3. Run the installer.
4. Launch Bookup from the Start Menu, the optional desktop shortcut, or the install folder.

The release also includes `Bookup-Windows-<version>-portable.zip` if you prefer a portable folder. Extract it and run:

```powershell
.\Bookup\Bookup.exe
```

The installer and portable zip include the desktop app, templates, static assets, board pieces, and bundled Stockfish runtime. They do not include your private `config.json`, Lichess token, or local `bookup_data\` cache.

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

## Build A Release

Maintainers can create the full local release bundle with:

```powershell
.\scripts\build_release.ps1 -Version 0.1.0
```

That creates:

- `release\Bookup-Windows-0.1.0-portable.zip`
- `release\Bookup-Setup-0.1.0.exe` when Inno Setup 6 is installed

To publish an official GitHub release, push a version tag:

```powershell
git tag v0.1.0
git push origin v0.1.0
```

The `.github/workflows/release.yml` workflow builds the Windows app, produces both release artifacts, and attaches them to the GitHub release.

## Local Data

Bookup stores local state in `bookup_data\` so it can reopen faster and remember your training work.

That includes:

- imported Chess.com games
- imported PGN games from manual local imports
- cached analyzed repertoires keyed by request/settings
- imported-game move-tree payloads
- health dashboard, training queue, transposition, and imported-tree payloads inside the saved profile snapshot
- rating progress snapshots from imported game headers, including daily W/D/L, win rate, score rate, rating changes, and separate time-control breakdowns
- Stockfish runtime summaries from the latest repertoire build, including worker count, analysis speed, cache hits, live hits, and elapsed time
- Smart Theory trees, source fingerprints, evaluations, warnings, and corrected-line data
- snapshot state for the latest profile
- training progress and review stats

If you rerun the exact same import and analysis settings, Bookup should load from cache instead of redoing the full work.

## Notes

- Leave `Time classes` as `all` for the full public archive.
- Use `Max games = 0` to import all public games.
- Add a local Lichess token only when you want direct desktop study export.
- Exact first-time loads can still take longer because Stockfish is doing real repertoire analysis.
- Repeat loads of the same request should be much faster because Bookup now reuses cached games and cached analyzed profiles.
- Imported-position history remains available separately from Stockfish, so your recorded moves are still visible while engine analysis is running.
- PGN import is local and uses the same analysis/cache pipeline as Chess.com imports.

## Current Direction

Bookup is aimed at repertoire study rather than generic game review.

The current product direction is:

- positions and branches you actually reach
- practical opponent replies from the database
- engine-backed candidate lines and eval
- move classifications on the board and in the side panels
- progress, measured accuracy, training, and source-aware Smart Theory surfaces that explain what to study next
- legal, validated variation trees that keep repertoire moves when they are good and make engine corrections when they are not
- a legal-move study board that helps you work on the lines that matter most

## Next Improvements

- background analysis for new positions before you open them
- stronger book-move detection from live opening context
- tighter drag-and-drop polish and board-interaction cleanup
- richer theory-tree filtering by side, result, and time control
- one-click “train against database” sessions that repeatedly choose common replies
