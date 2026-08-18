"use client";

import * as React from "react";
import { Store, Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import type { CategoryInfo } from "@/lib/types";
import { SearchSelect, type Option } from "@/components/ui/search-select";

export function CategorySelect({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (categoryId: string) => void;
}) {
  const [categories, setCategories] = React.useState<CategoryInfo[]>([]);
  const [loading, setLoading] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadPopular = React.useCallback(() => {
    api.categories({ popular: true }).then((d) => {
      if (Array.isArray(d)) setCategories(d);
    });
  }, []);

  React.useEffect(loadPopular, [loadPopular]);

  const onQuery = React.useCallback((q: string) => {
    if (timer.current) clearTimeout(timer.current);
    if (!q.trim()) {
      loadPopular();
      return;
    }
    setLoading(true);
    timer.current = setTimeout(() => {
      api
        .categories({ q })
        .then((d) => {
          if (Array.isArray(d)) setCategories(d);
          setLoading(false);
        })
        .catch(() => setLoading(false));
    }, 300);
  }, [loadPopular]);

  const options: Option[] = React.useMemo(
    () =>
      categories.map((c) => ({
        value: c.id,
        label: c.label,
        sublabel: c.family_label,
        meta: `${c.id} ${c.aliases.join(" ")}`,
      })),
    [categories],
  );

  return (
    <SearchSelect
      value={value}
      onChange={onChange}
      options={options}
      placeholder="Select an industry or business type"
      searchPlaceholder="e.g. pet grooming, cinema, gym…"
      searchable
      leftSlot={
        loading ? (
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
        ) : (
          <Store className="h-4 w-4 shrink-0 text-muted-foreground" />
        )
      }
      empty="No categories found"
      onQueryChange={onQuery}
    />
  );
}
