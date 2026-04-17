# Bookup

Bookup studies your public Chess.com games and builds a profile of how you actually play.

## What it does

- imports public Chess.com archive games by username and time control
- finds your most common openings and recurring opponent replies
- builds a style profile from your real games
- runs Stockfish over your moves to spot where you leak value
- explains where you can improve and what the engine wants instead

## Run

```powershell
cd C:\Users\adria\Downloads\Bookup
python -m pip install -r requirements.txt
python main.py
```

Then open `http://127.0.0.1:8877`.
