from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent
TEMP_DIST = ROOT / ".build_dist"
TEMP_WORK = ROOT / ".build_work"
TEMP_SPEC = ROOT / ".build_spec"
SOURCE_PACKAGE = TEMP_DIST / "Bookup"
FINAL_EXE = ROOT / "Bookup.exe"
FINAL_INTERNAL = ROOT / "_internal"
WINDOWS_RELEASE_PROCESSES = (
    "Bookup.exe",
    "stockfish-windows-x86-64-avx2.exe",
)
STOCKFISH_EXE = ROOT / "stockfish" / "stockfish-windows-x86-64-avx2.exe"
PACKAGED_STOCKFISH_EXE = FINAL_INTERNAL / "stockfish" / "stockfish-windows-x86-64-avx2.exe"


def remove_path(path: Path) -> None:
    if path.is_dir():
        shutil.rmtree(path, ignore_errors=True)
    elif path.exists():
        path.unlink()


def stop_release_processes() -> None:
    """Release packaged files before replacing the root-level app bundle."""
    if sys.platform != "win32":
        return
    for image_name in WINDOWS_RELEASE_PROCESSES:
        subprocess.run(
            ["taskkill", "/F", "/T", "/IM", image_name],
            cwd=ROOT,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )


def validate_windows_executable(path: Path, *, label: str) -> None:
    if not path.exists():
        raise FileNotFoundError(f"{label} is missing: {path}")

    size = path.stat().st_size
    if size < 1_000_000:
        preview = path.read_text(errors="ignore")[:160]
        if "git-lfs" in preview or "oid sha256" in preview:
            raise RuntimeError(
                f"{label} is a Git LFS pointer, not the real engine binary. "
                "Run `git lfs pull` before packaging."
            )
        raise RuntimeError(f"{label} is too small to be a valid engine binary: {size} bytes")

    with path.open("rb") as handle:
        header = handle.read(2)
    if header != b"MZ":
        raise RuntimeError(f"{label} is not a Windows executable: {path}")


def main() -> int:
    validate_windows_executable(STOCKFISH_EXE, label="Bundled Stockfish")
    stop_release_processes()

    for path in (TEMP_DIST, TEMP_WORK, TEMP_SPEC):
        remove_path(path)
        path.mkdir(parents=True, exist_ok=True)

    for stale in (FINAL_EXE, FINAL_INTERNAL):
        remove_path(stale)

    command = [
        sys.executable,
        "-m",
        "PyInstaller",
        "--noconfirm",
        "--clean",
        "--distpath",
        str(TEMP_DIST),
        "--workpath",
        str(TEMP_WORK),
        str(ROOT / "Bookup.spec"),
    ]
    subprocess.run(command, cwd=ROOT, check=True)

    if not SOURCE_PACKAGE.exists():
        raise FileNotFoundError(f"Expected packaged app at {SOURCE_PACKAGE}")

    shutil.copy2(SOURCE_PACKAGE / "Bookup.exe", FINAL_EXE)
    shutil.copytree(SOURCE_PACKAGE / "_internal", FINAL_INTERNAL, dirs_exist_ok=True)
    validate_windows_executable(PACKAGED_STOCKFISH_EXE, label="Packaged Stockfish")

    packaged_config = SOURCE_PACKAGE / "config.json"
    if packaged_config.exists() and not (ROOT / "config.json").exists():
        shutil.copy2(packaged_config, ROOT / "config.json")

    for path in (TEMP_DIST, TEMP_WORK, TEMP_SPEC):
        remove_path(path)

    print(f"Packaged Bookup at {FINAL_EXE}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
