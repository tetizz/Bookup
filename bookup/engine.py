from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from queue import Empty, Queue
import subprocess
import sys
import threading
import time

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


def hidden_engine_popen_args() -> dict:
    if sys.platform != "win32":
        return {}

    startupinfo = subprocess.STARTUPINFO()
    startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    startupinfo.wShowWindow = subprocess.SW_HIDE
    return {
        "creationflags": subprocess.CREATE_NO_WINDOW,
        "startupinfo": startupinfo,
    }


@dataclass(slots=True)
class EngineSettings:
    path: str
    depth: int = 24
    threads: int = 8
    hash_mb: int = 2048
    multipv: int = 5
    think_time_sec: float = 5.0
    parallel_workers: int = 1


class EngineSession:
    def __init__(self, settings: EngineSettings) -> None:
        self.settings = settings
        self._engine: chess.engine.SimpleEngine | None = None
        self._lock = threading.Lock()

    def __enter__(self) -> "EngineSession":
        self.open()
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.close()

    def open(self) -> None:
        if self._engine is not None:
            return
        self._engine = chess.engine.SimpleEngine.popen_uci(
            self.settings.path,
            **hidden_engine_popen_args(),
        )
        self._engine.configure(
            {
                "Threads": max(1, int(self.settings.threads)),
                "Hash": max(128, int(self.settings.hash_mb)),
            }
        )

    def close(self) -> None:
        if self._engine is None:
            return
        try:
            self._engine.quit()
        finally:
            self._engine = None

    def pid(self) -> int | None:
        """Best-effort process id for live runtime stats."""
        engine = self._engine
        if engine is None:
            return None
        transport = getattr(engine, "transport", None)
        if transport is None:
            return None
        try:
            pid = transport.get_pid()
        except Exception:
            return None
        try:
            return int(pid) if pid else None
        except (TypeError, ValueError):
            return None

    @property
    def engine(self) -> chess.engine.SimpleEngine:
        if self._engine is None:
            self.open()
        assert self._engine is not None
        return self._engine

    def analyse(
        self,
        board: chess.Board,
        depth: int | None = None,
        multipv: int | None = None,
        time_sec: float | None = None,
    ) -> list[dict]:
        # python-chess engines are not safe to use concurrently from one process.
        # Keep each Stockfish locked, and use EnginePool when we want real parallelism.
        with self._lock:
            limit_kwargs: dict[str, float | int] = {
                "depth": depth or self.settings.depth,
            }
            if time_sec is not None and float(time_sec) > 0:
                limit_kwargs["time"] = float(time_sec)
            info = self.engine.analyse(
                board,
                chess.engine.Limit(**limit_kwargs),
                multipv=max(1, int(multipv or self.settings.multipv)),
                info=chess.engine.INFO_SCORE | chess.engine.INFO_PV,
            )
            if isinstance(info, dict):
                return [info]
            return list(info)


class EnginePool:
    """A small pool of independent Stockfish processes.

    MultiPV searches several lines from one position. This pool is for the other
    bottleneck: analyzing several different positions at the same time while
    sharing CPU/hash budgets responsibly.
    """

    def __init__(self, settings: EngineSettings) -> None:
        self.settings = settings
        self.worker_count = max(1, int(settings.parallel_workers or 1))
        self._available: Queue[EngineSession] = Queue()
        self._sessions: list[EngineSession] = []
        self._open_lock = threading.Lock()
        self._stats_lock = threading.Lock()
        self._active_jobs = 0
        self._jobs_started = 0
        self._jobs_completed = 0
        self._closed = False

    def __enter__(self) -> "EnginePool":
        self.open()
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.close()

    def _worker_settings(self) -> EngineSettings:
        worker_threads = max(1, int(self.settings.threads) // self.worker_count)
        worker_hash = max(128, int(self.settings.hash_mb) // self.worker_count)
        return EngineSettings(
            path=self.settings.path,
            depth=self.settings.depth,
            threads=worker_threads,
            hash_mb=worker_hash,
            multipv=self.settings.multipv,
            think_time_sec=self.settings.think_time_sec,
            parallel_workers=1,
        )

    def open(self) -> None:
        if self._sessions:
            return
        with self._open_lock:
            if self._sessions:
                return
            self._closed = False
            for _index in range(self.worker_count):
                session = EngineSession(self._worker_settings())
                session.open()
                self._sessions.append(session)
                self._available.put(session)

    def close(self) -> None:
        with self._open_lock:
            self._closed = True
            sessions = list(self._sessions)
            self._sessions.clear()
        returned_sessions: list[EngineSession] = []
        deadline = time.monotonic() + 5.0
        while len(returned_sessions) < len(sessions):
            try:
                returned_sessions.append(self._available.get(timeout=0.1))
            except Empty:
                if time.monotonic() >= deadline:
                    break
        for session in set(returned_sessions):
            try:
                session.close()
            except Exception:
                pass

    def worker_pids(self) -> list[int]:
        pids: list[int] = []
        for session in list(self._sessions):
            pid = session.pid()
            if pid is not None:
                pids.append(pid)
        return pids

    def runtime_stats(self) -> dict[str, int]:
        with self._stats_lock:
            return {
                "active_workers": self._active_jobs,
                "jobs_started": self._jobs_started,
                "jobs_completed": self._jobs_completed,
            }

    def analyse(
        self,
        board: chess.Board,
        depth: int | None = None,
        multipv: int | None = None,
        time_sec: float | None = None,
    ) -> list[dict]:
        self.open()
        if self._closed:
            raise RuntimeError("Stockfish pool is closed.")
        session = self._available.get()
        try:
            with self._stats_lock:
                self._active_jobs += 1
                self._jobs_started += 1
            return session.analyse(board, depth=depth, multipv=multipv, time_sec=time_sec)
        finally:
            with self._stats_lock:
                self._active_jobs = max(0, self._active_jobs - 1)
                self._jobs_completed += 1
            if self._closed:
                session.close()
            else:
                self._available.put(session)
