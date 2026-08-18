"use client";

import * as React from "react";
import { AlertTriangle, CheckCircle2, Loader2, MapPin, Store, TrendingUp, Users } from "lucide-react";
import type { JobStatus } from "@/lib/types";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";

const STAGES: { id: string; label: string; icon: React.ReactNode }[] = [
  { id: "resolving", label: "Resolving city", icon: <MapPin className="h-3.5 w-3.5" /> },
  { id: "loading", label: "Loading city businesses", icon: <Store className="h-3.5 w-3.5" /> },
  { id: "categorizing", label: "Categorizing businesses", icon: <Store className="h-3.5 w-3.5" /> },
  { id: "peers", label: "Finding peer cities", icon: <Users className="h-3.5 w-3.5" /> },
  { id: "analyzing", label: "Calculating market gap", icon: <TrendingUp className="h-3.5 w-3.5" /> },
];

function stageIndex(stage: string): number {
  const i = STAGES.findIndex((s) => s.id === stage);
  return i === -1 ? 0 : i;
}

export function JobProgress({ job, kind }: { job: JobStatus | null; kind: string }) {
  if (!job) return null;
  const isErr = job.status === "error";
  const idx = stageIndex(job.stage);
  const isDone = job.status === "done";
  const isOpportunities = kind === "opportunities";

  return (
    <div className="mx-auto w-full max-w-md">
      <div className="mb-2 flex items-center justify-between text-xs">
        <span className="font-medium text-muted-foreground">
          {isErr ? "Something went wrong" : isDone ? "Complete" : "Working…"}
        </span>
        <span className="tabular-nums text-muted-foreground">{Math.round(job.progress * 100)}%</span>
      </div>
      <Progress value={job.progress} />
      <div className="mt-3 space-y-1.5">
        {STAGES.map((s, i) => {
          const state =
            isErr || isDone ? (i <= idx ? "done" : "todo") : i < idx ? "done" : i === idx ? "active" : "todo";
          return (
            <div key={s.id} className="flex items-center gap-2 text-xs">
              {state === "done" ? (
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
              ) : state === "active" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
              ) : (
                <span className="inline-block h-3.5 w-3.5 rounded-full border border-border" />
              )}
              <span className={cn(state === "todo" && "text-muted-foreground/60", state === "active" && "font-medium")}>
                {s.label}
              </span>
            </div>
          );
        })}
      </div>
      {job.message && (
        <p className="mt-3 truncate text-xs text-muted-foreground" title={job.message}>
          {job.message}
        </p>
      )}
      {isErr && (
        <div className="mt-3 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{job.error || "Unknown error. Please try again."}</span>
        </div>
      )}
      {isOpportunities && !isDone && (
        <p className="mt-3 text-xs text-muted-foreground">
          First run downloads the city and ~5–7 comparable cities — it can take a few minutes, then everything is cached.
        </p>
      )}
    </div>
  );
}
