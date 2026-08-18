"use client";

import * as React from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { PeerCity } from "@/lib/types";
import { scoreHex } from "@/lib/types";
import { cn } from "@/lib/utils";

const TARGET_COLOR = "#6366f1";
const PEER_COLOR = "#94a3b8";

function ChartTip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  const p = payload[0];
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2 text-xs shadow-card">
      <div className="font-medium text-foreground">{label}</div>
      <div className="mt-0.5 text-muted-foreground">
        {p.payload.role === "target" ? "This city · " : "Peer · "}
        <span className="font-semibold text-foreground">{typeof p.value === "number" ? p.value.toFixed(2) : p.value}</span>{" "}
        per 10k
      </div>
    </div>
  );
}

/** Businesses per 10,000 residents — target highlighted vs peers. */
export function PerCapitaChart({ cityName, cityPer10k, peers }: { cityName: string; cityPer10k: number | null | undefined; peers: PeerCity[] }) {
  const rows = [
    {
      name: cityName,
      value: cityPer10k ?? 0,
      role: "target",
      display: cityPer10k,
    },
    ...peers
      .filter((p) => p.per_10k !== null && p.per_10k !== undefined)
      .sort((a, b) => (a.per_10k ?? 0) - (b.per_10k ?? 0))
      .map((p) => ({ name: p.name, value: p.per_10k ?? 0, role: "peer", display: p.per_10k })),
  ];

  return (
    <ResponsiveContainer width="100%" height={320}>
      <BarChart data={rows} layout="vertical" margin={{ left: 8, right: 24, top: 4, bottom: 4 }}>
        <CartesianGrid horizontal={false} strokeDasharray="3 3" stroke="hsl(var(--border))" />
        <XAxis type="number" tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} axisLine={false} tickLine={false} />
        <YAxis
          type="category"
          dataKey="name"
          width={110}
          tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
          axisLine={false}
          tickLine={false}
        />
        <Tooltip content={<ChartTip />} cursor={{ fill: "hsl(var(--muted) / 0.4)" }} />
        <Bar dataKey="value" radius={[0, 4, 4, 0]} barSize={22} isAnimationActive={false}>
          {rows.map((r) => (
            <Cell key={r.name} fill={r.role === "target" ? TARGET_COLOR : PEER_COLOR} fillOpacity={r.role === "target" ? 1 : 0.7} />
          ))}
          <LabelList dataKey="display" position="right" formatter={(v: any) => (v === null || v === undefined ? "n/a" : Number(v).toFixed(2))} style={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Existing vs expected at benchmark. */
export function ExistingVsExpected({ existing, expected }: { existing: number; expected: number | null | undefined }) {
  const rows = [
    { name: "Existing", value: existing, color: "#6366f1" },
    { name: "Expected at benchmark", value: expected ?? 0, color: "#10b981" },
  ];
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={rows} layout="vertical" margin={{ left: 8, right: 24, top: 4, bottom: 4 }}>
        <CartesianGrid horizontal={false} strokeDasharray="3 3" stroke="hsl(var(--border))" />
        <XAxis type="number" tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} axisLine={false} tickLine={false} allowDecimals={false} />
        <YAxis type="category" dataKey="name" width={130} tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} axisLine={false} tickLine={false} />
        <Tooltip content={<ChartTip />} cursor={{ fill: "hsl(var(--muted) / 0.4)" }} />
        <Bar dataKey="value" radius={[0, 4, 4, 0]} barSize={30} isAnimationActive={false}>
          {rows.map((r) => (
            <Cell key={r.name} fill={r.color} />
          ))}
          <LabelList dataKey="value" position="right" formatter={(v: any) => Number(v).toLocaleString()} style={{ fontSize: 11, fill: "hsl(var(--muted-foreground))", fontWeight: 600 }} />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Supply position: Very Undersupplied ↔ Very Saturated. */
export function SupplyPosition({ gapPct, score }: { gapPct: number | null | undefined; score: number | null | undefined }) {
  const t = clamp((gapPct ?? 0) / 1.5, -1, 1);
  const color = scoreHex(score);
  return (
    <div className="pt-4">
      <div className="relative h-2.5 w-full rounded-full bg-gradient-to-r from-emerald-400 via-amber-400 to-rose-400 opacity-80" />
      <div className="absolute h-5 w-5 -translate-x-1/2 -translate-y-[7px] rounded-full border-4 border-background shadow-md" style={{ left: `${((t + 1) / 2) * 100}%`, background: color }} />
      <div className="mt-4 flex justify-between text-xs text-muted-foreground">
        <span>Very Undersupplied</span>
        <span className="font-medium" style={{ color }}>
          {score !== null && score !== undefined ? `${score}/100` : ""}
        </span>
        <span>Very Saturated</span>
      </div>
    </div>
  );
}

/** Confidence component breakdown bars. */
export function ConfidenceBreakdown({ components }: { components: Record<string, any> }) {
  const entries = Object.entries(components || {}).map(([key, v]) => ({
    key,
    label: key.replace(/_/g, " "),
    score: typeof v?.score === "number" ? v.score : 0,
    detail: v?.detail || "",
  }));
  if (!entries.length) return null;
  return (
    <div className="space-y-3">
      {entries.map((e) => (
        <div key={e.key}>
          <div className="mb-1 flex items-baseline justify-between gap-2 text-xs">
            <span className="font-medium capitalize text-foreground">{e.label}</span>
            <span className="text-muted-foreground">{e.detail}</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
            <div
              className="h-full rounded-full bg-primary/70 transition-all duration-700"
              style={{ width: `${Math.round(e.score * 100)}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}
