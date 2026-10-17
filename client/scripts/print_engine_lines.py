#!/usr/bin/env python3
"""Print the raw bytes of a line range from client/src/clientEngine.ts.

Used to see the exact CR/LF/quote state around a tsc error site when the
editor showed normalized `\r\n`-rendered text but str_replace kept missing.
"""
import sys

path = "C:\\Users\\Anania Light Laptop\\Downloads\\Blue Ocean\\client\\src\\clientEngine.ts"
start = int(sys.argv[1])
end = int(sys.argv[2])

with open(path, "r", encoding="utf-8") as f:
    lines = f.readlines()

for i in range(start - 1, min(end, len(lines))):
    line = lines[i].rstrip("\n")
    print(f"{i+1:05d}: {line!r}")
