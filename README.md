# Bookup

Bookup is a GPL repertoire trainer built from your real games. It imports your public Chess.com archive, learns the opening positions and branches you actually reach, uses Stockfish plus the Lichess opening database to study those positions, and lets you work through lines on a legal-move board.

## What Bookup Does

- imports public Chess.com games by username and time control
- supports `Import all public games`
- caches imported games and full analyzed repertoires locally so repeat loads are much faster
- builds a repertoire map from repeated positions you actually reach
- groups transpositions by position instead of only by opening label
- uses Stockfish for best moves, candidate lines, eval, coach explanations, and move classifications
- uses the Lichess opening database when available for practical move popularity and common replies
- builds a practical theory tree from imported games, split by games where you played White or Black
- generates on-demand theory lines from the current position or after a move you want to test
- filters out lines you already know well enough so the active queue stays focused
- classifies moves with Chess.com-style labels such as `Book`, `Best`, `Excellent`, `Great`, `Brilliant`, `Mistake`, and `Blunder`
- runs as a Windows desktop app instead of a plain browser tab

## Workspaces

- `Setup`
  Import games, configure the engine, add a Lichess token, and build or reload your repertoire.

- `Repertoire Map`
  See repeated repertoire positions and branches you actually reach, compare your repeated move with the recommended move, and open exact lines to work on.

- `Needs Work`
  Focus on repeated repertoire mistakes, due lines, fresh lines, and suggested repertoire updates.

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
  Explore your imported-game move tree and ask Stockfish to generate the next best moves from the current board position.

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

## Imported Game Tree Map

The `Theory` workspace includes a tree map built from your imported games only.

It includes:

- separate trees for games where you played White and games where you played Black
- Bookup-themed branch cards with weighted first moves, branch percentages, and opening labels
- clear labels for `your move` versus `opponent reply`
- a deep branch explorer under the visual map
- click-to-load nodes that open the exact resulting FEN on the Study Lines analysis board

## Theory

The `Theory` workspace has two study tools:

- `Imported Games Theory Tree`
  Shows the move tree from your imported games only. Click any branch card to open that exact position on the Study Lines board.

- `Theory Generator`
  Uses the current Study Lines board position. You can optionally enter a UCI move such as `e2e4`, then generate the next 10 best moves, or any value from 1 to 30, using the saved Stockfish settings.

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
- cached analyzed repertoires keyed by request/settings
- imported-game move-tree payloads
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

## Current Direction

Bookup is aimed at repertoire study rather than generic game review.

The current product direction is:

- positions and branches you actually reach
- practical opponent replies from the database
- engine-backed candidate lines and eval
- move classifications on the board and in the side panels
- a legal-move study board that helps you work on the lines that matter most

## Next Improvements

- clickable engine lines that jump the board into that variation
- clickable move-tree branches that jump the analysis board into that position
- background analysis for new positions before you open them
- stronger book-move detection from live opening context
- tighter drag-and-drop polish and board-interaction cleanup
- optional PGN import in addition to Chess.com archive import
