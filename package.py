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


def remove_path(path: Path) -> None:
    if path.is_dir():
        shutil.rmtree(path, ignore_errors=True)
    elif path.exists():
        path.unlink()


def main() -> int:
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

    packaged_config = SOURCE_PACKAGE / "config.json"
    if packaged_config.exists() and not (ROOT / "config.json").exists():
        shutil.copy2(packaged_config, ROOT / "config.json")

    for path in (TEMP_DIST, TEMP_WORK, TEMP_SPEC):
        remove_path(path)

    print(f"Packaged Bookup at {FINAL_EXE}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
