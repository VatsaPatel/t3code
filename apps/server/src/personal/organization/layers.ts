/**
 * Production wiring for personal organization: the store, the organizer on
 * the shared Scheduler, and a classifier backed by the user's configured
 * text-generation model.
 */
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  PERSONAL_ORGANIZATION_WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeOS from "node:os";

import * as ProviderInstanceRegistry from "../../provider/Services/ProviderInstanceRegistry.ts";
import * as Scheduler from "../../scheduling/Scheduler.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as PersonalOrganizationService from "./PersonalOrganizationService.ts";
import * as PersonalOrganizer from "./PersonalOrganizer.ts";

const M = PERSONAL_ORGANIZATION_WS_METHODS;

/** Spread into RPC_REQUIRED_SCOPES. */
export const PERSONAL_ORGANIZATION_RPC_SCOPES = {
  [M.getSnapshot]: AuthOrchestrationReadScope,
  [M.subscribe]: AuthOrchestrationReadScope,
  [M.upsertGroup]: AuthOrchestrationOperateScope,
  [M.deleteGroup]: AuthOrchestrationOperateScope,
  [M.moveThread]: AuthOrchestrationOperateScope,
  [M.undoMove]: AuthOrchestrationOperateScope,
  [M.acceptSuggestion]: AuthOrchestrationOperateScope,
  [M.resetThread]: AuthOrchestrationOperateScope,
  [M.runOrganizer]: AuthOrchestrationOperateScope,
  [M.updateOrganizerSettings]: AuthOrchestrationOperateScope,
  [M.listThreadDetails]: AuthOrchestrationReadScope,
} as const;

export const classifierLayer = Layer.effect(
  PersonalOrganizer.OrganizerClassifier,
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
    return PersonalOrganizer.makeTextGenerationClassifier({
      getSettings: settings.getSettings,
      getTextGeneration: (instanceId) =>
        registry.getInstance(instanceId).pipe(Effect.map((instance) => instance?.textGeneration)),
      fallbackCwd: NodeOS.homedir(),
    });
  }),
);

const storeLayer = PersonalOrganizationService.layer;

export const layer = Layer.mergeAll(
  storeLayer,
  PersonalOrganizer.layer.pipe(
    Layer.provide(storeLayer),
    Layer.provide(classifierLayer),
    // Same layer reference as the orchestration runtime, so memoization
    // shares the one Scheduler clock.
    Layer.provide(Scheduler.layer),
  ),
);
