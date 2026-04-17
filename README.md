# Bookup

Bookup studies your public Chess.com games and builds a profile of how you actually play.

## What it does

- imports public Chess.com archive games by username and time control
- uses Chess.com's public game archive endpoint and per-month public game feeds
- finds your most common openings and recurring opponent replies
- builds a style profile from your real games
- runs Stockfish over your moves to spot where you leak value
- explains where you can improve and what the engine wants instead
- shows a board for common mistakes and opening positions
- opens as a desktop GUI window instead of a plain browser tab

## Desktop EXE

After packaging, the Windows desktop build is here:

```powershell
C:\Users\adria\Downloads\Bookup\dist\Bookup\Bookup.exe
```

That packaged app includes:

- the GUI window
- the board and piece assets
- the bundled local Stockfish executable in `stockfish/`

## Run

```powershell
cd C:\Users\adria\Downloads\Bookup
python -m pip install -r requirements.txt
python main.py
```

Leave `Time classes` set to `all` to scan all public games, or enter a comma-separated filter like `rapid,blitz`.
