import type {
  AttentionRollup,
  ThreadAttention,
} from "@t3tools/client-runtime/personal/organizationTree";

import { cn } from "../../lib/utils";

const DOT_CLASS: Record<Exclude<ThreadAttention, "idle">, string> = {
  needs_you: "bg-warning",
  working: "bg-success",
  failed: "bg-destructive",
};

const DOT_LABEL: Record<Exclude<ThreadAttention, "idle">, string> = {
  needs_you: "Needs you",
  working: "Working",
  failed: "Failed",
};

/** A 6px state dot; renders nothing for idle. */
export function AttentionDot(props: {
  readonly attention: ThreadAttention;
  readonly className?: string;
}) {
  if (props.attention === "idle") return null;
  return (
    <span
      role="img"
      aria-label={DOT_LABEL[props.attention]}
      className={cn("size-1.5 shrink-0 rounded-full", DOT_CLASS[props.attention], props.className)}
    />
  );
}

/** Needs you wins, then working, then failed. */
export function rollupAttention(rollup: AttentionRollup): ThreadAttention {
  if (rollup.needsYou > 0) return "needs_you";
  if (rollup.working > 0) return "working";
  if (rollup.failed > 0) return "failed";
  return "idle";
}
