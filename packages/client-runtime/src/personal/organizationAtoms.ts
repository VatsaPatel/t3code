/**
 * Environment-scoped atoms for personal organization. The live atom folds the
 * snapshot+delta stream into `PersonalOrganizationState`.
 */
import { PERSONAL_ORGANIZATION_WS_METHODS } from "@t3tools/contracts";
import * as Stream from "effect/Stream";
import type { Atom } from "effect/unstable/reactivity";

import type * as EnvironmentRegistry from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "../state/runtime.ts";
import { reducePersonalOrganization, type PersonalOrganizationState } from "./organizationState.ts";

const M = PERSONAL_ORGANIZATION_WS_METHODS;

export function createPersonalOrganizationAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, E>,
) {
  return {
    /** Live groups, placements, and organizer status for one environment. */
    organizationLive: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:personal-organization:live",
      tag: M.subscribe,
      transform: (stream) =>
        stream.pipe(
          Stream.scan(null as PersonalOrganizationState | null, reducePersonalOrganization),
          Stream.filter((state): state is PersonalOrganizationState => state !== null),
        ),
    }),
    /** Origin, message count, and last-message snippet per thread (chat manager). */
    threadDetails: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:personal-organization:thread-details",
      tag: M.listThreadDetails,
      staleTimeMs: 30_000,
    }),
    upsertGroup: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:personal-organization:upsert-group",
      tag: M.upsertGroup,
    }),
    deleteGroup: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:personal-organization:delete-group",
      tag: M.deleteGroup,
    }),
    moveThread: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:personal-organization:move-thread",
      tag: M.moveThread,
    }),
    undoMove: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:personal-organization:undo-move",
      tag: M.undoMove,
    }),
    acceptSuggestion: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:personal-organization:accept-suggestion",
      tag: M.acceptSuggestion,
    }),
    resetThread: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:personal-organization:reset-thread",
      tag: M.resetThread,
    }),
    runOrganizer: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:personal-organization:run-organizer",
      tag: M.runOrganizer,
    }),
    updateOrganizerSettings: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:personal-organization:update-organizer-settings",
      tag: M.updateOrganizerSettings,
    }),
  };
}
