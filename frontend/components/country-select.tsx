"use client";

import * as React from "react";
import { Globe } from "lucide-react";
import { api } from "@/lib/api";
import type { Country } from "@/lib/types";
import { SearchSelect, type Option } from "@/components/ui/search-select";

// Common alternate names / codes so casual queries match: "usa", "uk", "uae",
// "holland", "türkiye", "russia", "korea", "czechia", "burma" ...
const COUNTRY_ALIASES: Record<string, string[]> = {
  "United States": ["usa", "us", "america", "united states of america"],
  "United Kingdom": ["uk", "britain", "great britain", "england"],
  "United Arab Emirates": ["uae", "emirates"],
  "Kingdom of the Netherlands": ["holland", "netherlands", "the netherlands"],
  Turkey: ["türkiye", "turkiye"],
  Russia: ["russian federation"],
  "South Korea": ["korea", "rok"],
  "North Korea": ["dprk"],
  "Czech Republic": ["czechia", "czech"],
  "Democratic Republic of the Congo": ["drc", "congo kinshasa", "congo (drc)"],
  "Republic of the Congo": ["congo brazzaville", "congo"],
  "Ivory Coast": ["cote d'ivoire", "côte d'ivoire"],
  Myanmar: ["burma"],
  Eswatini: ["swaziland"],
  "Cape Verde": ["cabo verde"],
  "North Macedonia": ["macedonia"],
  "Bosnia and Herzegovina": ["bosnia", "herzegovina"],
  "Timor-Leste": ["east timor", "timor leste"],
  Laos: ["lao pdr"],
  Brunei: ["brunei darussalam"],
  Venezuela: ["venezuela (bolivarian republic)"],
  Tanzania: ["united republic of tanzania"],
  Vietnam: ["viet nam"],
  "Western Sahara": ["sahrawi"],
  Palestine: ["state of palestine"],
  Taiwan: ["republic of china", "taiwan, province of china"],
  "Dominican Republic": ["dominicana"],
};

export function CountrySelect({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (countryName: string, cca2: string) => void;
}) {
  const [countries, setCountries] = React.useState<Country[]>([]);

  React.useEffect(() => {
    api.countries().then(setCountries).catch(() => {});
  }, []);

  const handleChange = React.useCallback(
    (name: string) => {
      const c = countries.find((x) => x.name === name);
      onChange(name, c?.cca2 || "");
    },
    [countries, onChange],
  );

  const options: Option[] = React.useMemo(() => {
    // Dedupe by name — the API returns some countries twice (different regions)
    // and duplicate option values corrupt the select's list rendering.
    const seen = new Set<string>();
    const out: Option[] = [];
    for (const c of countries) {
      if (seen.has(c.name)) continue;
      seen.add(c.name);
      const aliases = COUNTRY_ALIASES[c.name] || [];
      out.push({
        value: c.name,
        label: c.name,
        sublabel: c.region || undefined,
        meta: [c.cca2, ...aliases].filter(Boolean).join(" "),
      });
    }
    return out;
  }, [countries]);

  return (
    <SearchSelect
      value={value}
      onChange={handleChange}
      options={options}
      placeholder="Select a country"
      searchPlaceholder="Search 200+ countries…"
      leftSlot={<Globe className="h-4 w-4 shrink-0 text-muted-foreground" />}
      empty="No country found"
    />
  );
}
