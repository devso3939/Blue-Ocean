"use client";

import * as React from "react";
import { Building2, Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import type { CityCandidate } from "@/lib/types";
import { SearchSelect, type Option } from "@/components/ui/search-select";

export function CitySelect({
  country,
  value,
  onChange,
  disabled,
}: {
  country: string | null;
  value: string | null;
  onChange: (candidate: CityCandidate) => void;
  disabled?: boolean;
}) {
  const [candidates, setCandidates] = React.useState<CityCandidate[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [searching, setSearching] = React.useState("");
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const seq = React.useRef(0);

  React.useEffect(() => {
    seq.current += 1;
    setCandidates([]);
    setSearching("");
    setLoading(false);
  }, [country]);

  const onQuery = React.useCallback(
    (q: string) => {
      setSearching(q);
      if (timer.current) clearTimeout(timer.current);
      if (!country || q.trim().length < 2) {
        seq.current += 1;
        setCandidates([]);
        setLoading(false);
        return;
      }
      const my = ++seq.current;
      setLoading(true);
      timer.current = setTimeout(() => {
        const t = setTimeout(() => {
          // Timeout guard: never leave the spinner stuck if the upstream
          // (Wikidata SPARQL) is slow on a cold cache.
          if (seq.current === my) setLoading(false);
        }, 12000);
        api
          .citiesSearch(q, country)
          .then((c) => {
            clearTimeout(t);
            if (seq.current === my) {
              setCandidates(c);
              setLoading(false);
            }
          })
          .catch(() => {
            clearTimeout(t);
            if (seq.current === my) {
              setCandidates([]);
              setLoading(false);
            }
          });
      }, 450);
    },
    [country],
  );

  const options: Option[] = React.useMemo(
    () =>
      candidates.map((c) => ({
        value: c.name,
        label: c.name,
        sublabel: c.description ? `${c.description} · ${c.country_code}` : c.country_code,
        meta: c.country_code,
      })),
    [candidates],
  );

  const onPick = (name: string) => {
    const c = candidates.find((x) => x.name === name);
    if (c) onChange(c);
  };

  const hint = searching.trim().length < 2 && !value ? "Type at least 2 characters…" : undefined;

  return (
    <SearchSelect
      value={value}
      onChange={onPick}
      options={options}
      placeholder={disabled ? "Select a country first" : "Type a city anywhere in the world"}
      searchPlaceholder="Type a city name…"
      searchable
      leftSlot={
        loading ? (
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
        ) : (
          <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" />
        )
      }
      empty={hint || (loading ? "Searching…" : "No cities found")}
      disabled={disabled || !country}
      onQueryChange={onQuery}
    />
  );
}
