#!/usr/bin/env python3
import sys
from pathlib import Path

path = Path(r"C:\Users\Anania Light Laptop\Downloads\Blue Ocean\client\src\clientEngine.ts")
lines = path.read_text(encoding="utf-8").splitlines(True)

start = int(sys.argv[1])
end = int(sys.argv[2])

for i in range(start - 1, min(end, len(lines))):
    print(f"{i+1:05d}: {lines[i]!r}")
