# Bookup

Bookup is a repertoire prep trainer built from your real games. It imports your public Chess.com archive, turns recurring opening positions into a repertoire tree, uses Stockfish to recommend the best continuations, and drills those lines on a legal-move training board.

## What Bookup Does

- imports public Chess.com games by username and time control
- supports importing the full public archive with `Import all public games`
- builds a repertoire tree from the positions you actually reach
- uses named openings first, with ECO codes kept as secondary metadata
- uses Lichess explorer optionally to weight common opponent replies
- uses Stockfish to recommend best continuations and explain missed moves
- filters out known lines you already play correctly often enough
- drills positions in a trainer with legal move validation, drag/click input, and continuation playback
- runs as a desktop GUI window instead of a plain browser tab

## App Workspaces

- `Setup`
  Import games, configure Stockfish, and optionally add a Lichess token.
- `My Repertoire`
  See your first moves, opening families, and the position tree you actually reach.
- `Improve Repertoire`
  Study urgent lines, rare sidelines, and engine-approved repertoire updates.
- `Review Mistakes`
  Revisit opening mistakes that matter for your prep.
- `Trainer`
  Solve positions on the board, get coached on misses, and review lines until they stick.

## Run From Source

```powershell
python -m pip install -r requirements.txt
python main.py
```

### Inputs

- `Chess.com username`
  Required to import your public games.
- `Lichess token`
  Optional. Enables live Lichess explorer data for branch frequency and move popularity.
- `Stockfish path`
  Required when running from source unless the bundled engine path is already available on your machine.

## Desktop EXE

The packaged Windows app is launched from the top-level Bookup folder:

```powershell
.\Bookup.exe
```

After packaging, the Bookup folder keeps:

- `Bookup.exe`
- `_internal\`
  Runtime assets, templates, board pieces, and the bundled Stockfish executable
- `config.json`
  Saved local settings if present

## Build The EXE

To rebuild the desktop app into the clean top-level layout:

```powershell
python package.py
```

That command recreates:

- `Bookup.exe`
- `_internal\`

without leaving the old `dist\Bookup\...` layout behind.

## Training Notes

- Leave `Time classes` set to `all` to use the full public archive.
- Use `Max games = 0` to import all public games.
- Add a Lichess token if you want richer opponent-reply frequency from the live explorer.
- The trainer focuses on repertoire positions rather than generic full-game review.

## Coming Next

- persistent spaced-repetition scheduling per line
- repertoire chapters by opening family
- coverage tracking for common replies you have learned vs still need to train
- wrong-move heatmap for the branches you miss most often
- drill modes for `Play the next move`, `Play the full line`, and `Survival mode`
- opening-family filters in the trainer queue
- stronger engine explanations that coach the idea behind the move
- optional PGN file import in addition to Chess.com archive import
