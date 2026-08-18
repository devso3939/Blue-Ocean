"use client";

import * as React from "react";
import { Check, ChevronDown, Search } from "lucide-react";
import { cn } from "@/lib/utils";

export interface Option {
  value: string;
  label: string;
  sublabel?: string;
  meta?: string;
}

export function SearchSelect({
  value,
  onChange,
  options,
  placeholder = "Select…",
  searchPlaceholder = "Search…",
  searchable = true,
  empty = "No matches",
  leftSlot,
  disabled,
  onQueryChange,
}: {
  value: string | null;
  onChange: (v: string) => void;
  options: Option[];
  placeholder?: string;
  searchPlaceholder?: string;
  searchable?: boolean;
  empty?: string;
  leftSlot?: React.ReactNode;
  disabled?: boolean;
  onQueryChange?: (q: string) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");

  const setQuerySafe = (q: string) => {
    setQuery(q);
    onQueryChange?.(q);
  };
  const boxRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const selected = options.find((o) => o.value === value) || null;

  React.useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  // Ranked fuzzy matching: case/diacritic-insensitive, whitespace-collapsed.
  // Scores: exact > prefix > substring > loose subsequence ("lndn" -> London).
  // Results are deduped by value — duplicate keys in the option list corrupt
  // React's list reconciliation and pin stale entries above every result.
  const norm = (s: string) =>
    s
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  const nq = norm(query);
  const isSubsequence = (hay: string, q: string) => {
    let i = 0;
    for (const ch of hay) {
      if (ch === q[i]) i += 1;
      if (i === q.length) return true;
    }
    return false;
  };
  let filtered: Option[];
  if (!nq) {
    filtered = options;
  } else {
    filtered = options
      .map((o) => {
        const label = norm(o.label);
        const hay = norm(`${o.label} ${o.sublabel || ""} ${o.meta || ""}`);
        let score = -1;
        if (label === nq) score = 100;
        else if (label.startsWith(nq)) score = 80;
        else if (hay.includes(nq)) score = 60;
        else if (nq.length >= 4 && isSubsequence(label, nq)) score = 30;
        return { o, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || norm(a.o.label).localeCompare(norm(b.o.label)))
      .map((x) => x.o);
  }
  const seen = new Set<string>();
  const deduped: Option[] = [];
  for (const o of filtered) {
    if (seen.has(o.value)) continue;
    seen.add(o.value);
    deduped.push(o);
  }

  return (
    <div ref={boxRef} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          setOpen((v) => !v);
          if (!value) {
            setQuerySafe("");
          }
          setTimeout(() => inputRef.current?.focus(), 10);
        }}
        className={cn(
          "flex h-11 w-full items-center justify-between gap-2 rounded-md border border-input bg-background px-3 text-sm shadow-sm transition-colors hover:bg-accent/40 disabled:opacity-50",
          open && "ring-2 ring-ring",
        )}
      >
        <span className="flex min-w-0 items-center gap-2">
          {leftSlot}
          <span className={cn("truncate", !selected && "text-muted-foreground")}>
            {selected ? selected.label : value || placeholder}
          </span>
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
      </button>

      {open && (
        <div className="absolute z-50 mt-1.5 w-full overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-xl">
          {searchable && (
            <div className="flex items-center gap-2 border-b border-border px-3 py-2">
              <Search className="h-3.5 w-3.5 text-muted-foreground" />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuerySafe(e.target.value)}
                placeholder={searchPlaceholder}
                className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
            </div>
          )}
          <div className="max-h-64 overflow-y-auto p-1">
            {deduped.length === 0 && (
              <div className="px-3 py-6 text-center text-xs text-muted-foreground">{empty}</div>
            )}
            {deduped.slice(0, 120).map((o, idx) => (
              <button
                key={`${o.value}:${idx}`}
                type="button"
                onClick={() => {
                  onChange(o.value);
                  setOpen(false);
                }}
                className={cn(
                  "flex w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-accent",
                  o.value === value && "bg-accent",
                )}
              >
                <span className="min-w-0">
                  <span className="block truncate font-medium">{o.label}</span>
                  {o.sublabel && (
                    <span className="block truncate text-xs text-muted-foreground">{o.sublabel}</span>
                  )}
                </span>
                {o.value === value ? <Check className="h-4 w-4 shrink-0 text-primary" /> : null}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
