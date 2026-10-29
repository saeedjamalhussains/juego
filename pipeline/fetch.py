"""Download raw source tables into data/raw/ (idempotent)."""

import sys
import time
import urllib.request
from pathlib import Path

from sources import TRANSFERMARKT_BASE, TRANSFERMARKT_TABLES

RAW = Path(__file__).resolve().parent.parent / "data" / "raw"


def fetch(force: bool = False) -> None:
    RAW.mkdir(parents=True, exist_ok=True)
    for table in TRANSFERMARKT_TABLES:
        dest = RAW / f"{table}.csv.gz"
        if dest.exists() and not force:
            print(f"  ✓ {table:<18} cached")
            continue
        url = f"{TRANSFERMARKT_BASE}/{table}.csv.gz"
        t0 = time.time()
        tmp = dest.with_suffix(".part")
        # No cookies, no identifying headers beyond a generic UA.
        req = urllib.request.Request(url, headers={"User-Agent": "juego-pipeline"})
        with urllib.request.urlopen(req, timeout=120) as r, open(tmp, "wb") as f:
            while chunk := r.read(1 << 16):
                f.write(chunk)
        tmp.rename(dest)
        print(f"  ↓ {table:<18} {dest.stat().st_size / 1e6:6.1f} MB  {time.time() - t0:4.1f}s")


if __name__ == "__main__":
    fetch(force="--force" in sys.argv)
