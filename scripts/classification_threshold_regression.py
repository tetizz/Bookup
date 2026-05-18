from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
REPO_ROOT = ROOT.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from bookup.classifications import point_loss_classification_key


def _assert_equal(actual: str, expected: str, label: str) -> None:
    if actual != expected:
        raise AssertionError(f"{label}: expected {expected}, got {actual}")


def run() -> None:
    exact_cases = [
        ("best exact zero", 0.0, True, "best"),
        ("excellent lower", 0.0, False, "excellent"),
        ("excellent upper", 0.02, False, "excellent"),
        ("good lower", 0.0201, False, "good"),
        ("good upper", 0.05, False, "good"),
        ("inaccuracy lower", 0.0501, False, "inaccuracy"),
        ("inaccuracy upper", 0.10, False, "inaccuracy"),
        ("mistake lower", 0.1001, False, "mistake"),
        ("mistake upper", 0.20, False, "mistake"),
        ("blunder lower", 0.2001, False, "blunder"),
        ("blunder upper", 1.0, False, "blunder"),
    ]

    for name, loss, is_best, expected in exact_cases:
        actual = point_loss_classification_key(loss, is_best_move=is_best)
        _assert_equal(actual, expected, name)

    print("classification threshold regression passed")


if __name__ == "__main__":
    run()
