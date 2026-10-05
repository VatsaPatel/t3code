/** Thin WS handlers for personal organization; spread into ws.ts's handler map. */
import { PERSONAL_ORGANIZATION_WS_METHODS as M } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { observeRpcEffect, observeRpcStream } from "../../observability/RpcInstrumentation.ts";
import { PersonalOrganizationService } from "./PersonalOrganizationService.ts";
import { PersonalOrganizer } from "./PersonalOrganizer.ts";

const attributes = { "rpc.aggregate": "personalOrganization" };

export const makePersonalOrganizationRpcHandlers = Effect.gen(function* () {
  const store = yield* PersonalOrganizationService;
  const organizer = yield* PersonalOrganizer;
  return {
    [M.getSnapshot]: (_input: {}) =>
      observeRpcEffect(M.getSnapshot, store.getSnapshot(), attributes),
    [M.subscribe]: (_input: {}) => observeRpcStream(M.subscribe, store.subscribe(), attributes),
    [M.upsertGroup]: (input: Parameters<typeof store.upsertGroup>[0]) =>
      observeRpcEffect(M.upsertGroup, store.upsertGroup(input), attributes),
    [M.deleteGroup]: (input: Parameters<typeof store.deleteGroup>[0]) =>
      observeRpcEffect(M.deleteGroup, store.deleteGroup(input), attributes),
    [M.moveThread]: (input: Parameters<typeof store.moveThread>[0]) =>
      observeRpcEffect(M.moveThread, store.moveThread(input), attributes),
    [M.undoMove]: (input: Parameters<typeof store.undoMove>[0]) =>
      observeRpcEffect(M.undoMove, store.undoMove(input), attributes),
    [M.acceptSuggestion]: (input: Parameters<typeof store.acceptSuggestion>[0]) =>
      observeRpcEffect(M.acceptSuggestion, store.acceptSuggestion(input), attributes),
    [M.resetThread]: (input: Parameters<typeof store.resetThread>[0]) =>
      observeRpcEffect(M.resetThread, store.resetThread(input), attributes),
    [M.runOrganizer]: (_input: {}) =>
      observeRpcEffect(M.runOrganizer, organizer.runNow(), attributes),
    [M.updateOrganizerSettings]: (input: {
      readonly mode: Parameters<typeof store.setOrganizerMode>[0];
    }) =>
      observeRpcEffect(M.updateOrganizerSettings, store.setOrganizerMode(input.mode), attributes),
    [M.listThreadDetails]: (_input: {}) =>
      observeRpcEffect(M.listThreadDetails, store.listThreadDetails(), attributes),
  } as const;
});
