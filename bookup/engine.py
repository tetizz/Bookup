from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import sys

import chess
import chess.engine


ROOT_DIR = Path(__file__).resolve().parent.parent
RUNTIME_DIR = Path(sys.executable).resolve().parent if getattr(sys, "frozen", False) else ROOT_DIR
RESOURCE_DIR = Path(getattr(sys, "_MEIPASS", ROOT_DIR))

DEFAULT_ENGINE_HINTS = [
    RESOURCE_DIR / "stockfish" / "stockfish-windows-x86-64-avx2.exe",
    RESOURCE_DIR / "stockfish.exe",
    RUNTIME_DIR / "stockfish.exe",
    RUNTIME_DIR / "stockfish" / "stockfish-windows-x86-64-avx2.exe",
    ROOT_DIR / "stockfish.exe",
    ROOT_DIR / "stockfish" / "stockfish-windows-x86-64-avx2.exe",
    Path(r"C:\Users\adria\Downloads\Brilliant-move-finder\stockfish\stockfish-windows-x86-64-avx2.exe"),
    Path(r"C:\Users\adria\Downloads\Brilliant-move-finder\release\Brilliant Move Finder\stockfish\stockfish-windows-x86-64-avx2.exe"),
]


def default_engine_path() -> str:
    for candidate in DEFAULT_ENGINE_HINTS:
        if candidate.exists():
            return str(candidate)
    return ""


@dataclass(slots=True)
class EngineSettings:
    path: str
    depth: int = 13
    threads: int = 8
    hash_mb: int = 2048


class EngineSession:
    def __init__(self, settings: EngineSettings) -> None:
        self.settings = settings
        self._engine: chess.engine.SimpleEngine | None = None

    def __enter__(self) -> "EngineSession":
        self.open()
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.close()

    def open(self) -> None:
        if self._engine is not None:
            return
        self._engine = chess.engine.SimpleEngine.popen_uci(self.settings.path)
        self._engine.configure(
            {
                "Threads": max(1, int(self.settings.threads)),
                "Hash": max(128, int(self.settings.hash_mb)),
            }
        )

    def close(self) -> None:
        if self._engine is None:
            return
        self._engine.quit()
        self._engine = None

    @property
    def engine(self) -> chess.engine.SimpleEngine:
        if self._engine is None:
            self.open()
        assert self._engine is not None
        return self._engine

    def analyse(self, board: chess.Board, depth: int | None = None, multipv: int = 1) -> list[dict]:
        info = self.engine.analyse(
            board,
            chess.engine.Limit(depth=depth or self.settings.depth),
            multipv=max(1, multipv),
            info=chess.engine.INFO_SCORE | chess.engine.INFO_PV,
        )
        if isinstance(info, dict):
            return [info]
        return list(info)
