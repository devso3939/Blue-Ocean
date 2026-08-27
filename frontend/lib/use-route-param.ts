"use client";

import * as React from "react";
import { useParams } from "next/navigation";

/**
 * Resolves the real dynamic-route param in every deployment mode:
 * - next dev / next start: useParams returns the actual segment
 * - static export: prerendered params match the URL and it also works
 * - SPA fallback (static export served by FastAPI's catch-all): the root
 *   page renders at a deep URL, so the id is recovered from window.location.
 * Returns null until mounted, so SSR/SSG markup stays hydration-safe.
 */
export function useRouteParam(
  prerendered: string | undefined,
  pattern: RegExp,
): string | null {
  const params = useParams();
  const key = params ? Object.keys(params)[0] : "";
  const raw = key ? (params as Record<string, string>)[key] : undefined;
  const [locParam, setLocParam] = React.useState<string | null>(null);

  React.useEffect(() => {
    const m = window.location.pathname.match(pattern);
    setLocParam(m ? decodeURIComponent(m[1]) : null);
  }, [pattern]);

  if (prerendered && prerendered !== "placeholder") return prerendered;
  return locParam ?? (typeof raw === "string" ? raw : null);
}
