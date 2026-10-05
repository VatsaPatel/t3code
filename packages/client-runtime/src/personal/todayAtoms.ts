import { PERSONAL_TODAY_WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/unstable/reactivity";

import type * as EnvironmentRegistry from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "../state/runtime.ts";

/**
 * Atoms for the Today hub's host state on one environment: tasks, Hermes
 * routines and the brief. A client mounts them against the environment that
 * owns that state (normally the primary one).
 */
export function createPersonalTodayAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, E>,
) {
  return {
    /** Snapshot stream; while mounted, the server keeps the task list fresh. */
    live: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "personal-today:live",
      tag: PERSONAL_TODAY_WS_METHODS.subscribe,
    }),
    /** Latest brief that landed while subscribed; a new value is a new brief. */
    briefArrivals: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "personal-today:brief-arrivals",
      tag: PERSONAL_TODAY_WS_METHODS.subscribeBriefs,
      idleTtlMs: 0,
    }),
    pendingPrompts: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "personal-today:pending-prompts",
      tag: PERSONAL_TODAY_WS_METHODS.pendingPrompts,
      staleTimeMs: 15_000,
    }),
    routineHistory: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "personal-today:routine-history",
      tag: PERSONAL_TODAY_WS_METHODS.routineHistory,
      staleTimeMs: 30_000,
    }),
    refresh: createEnvironmentRpcCommand(runtime, {
      label: "personal-today:refresh",
      tag: PERSONAL_TODAY_WS_METHODS.refresh,
      concurrency: { mode: "singleFlight", key: ({ environmentId }) => environmentId },
    }),
    taskAction: createEnvironmentRpcCommand(runtime, {
      label: "personal-today:task-action",
      tag: PERSONAL_TODAY_WS_METHODS.taskAction,
    }),
    routineAction: createEnvironmentRpcCommand(runtime, {
      label: "personal-today:routine-action",
      tag: PERSONAL_TODAY_WS_METHODS.routineAction,
    }),
    updateSettings: createEnvironmentRpcCommand(runtime, {
      label: "personal-today:update-settings",
      tag: PERSONAL_TODAY_WS_METHODS.updateSettings,
    }),
  };
}
