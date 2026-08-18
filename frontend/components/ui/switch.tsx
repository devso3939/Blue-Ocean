import * as React from "react";
import { cn } from "@/lib/utils";

export function Switch({
  checked,
  onCheckedChange,
  label,
  disabled,
}: {
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "group inline-flex items-center gap-2 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50",
      )}
    >
      <span
        className={cn(
          "relative inline-flex h-4.5 w-8 shrink-0 items-center rounded-full border border-border transition-colors",
          checked ? "bg-primary" : "bg-muted",
        )}
        style={{ height: 18, width: 34 }}
      >
        <span
          className={cn(
            "inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform",
            checked ? "translate-x-4" : "translate-x-0.5",
          )}
          style={{ height: 14, width: 14 }}
        />
      </span>
      {label}
    </button>
  );
}
