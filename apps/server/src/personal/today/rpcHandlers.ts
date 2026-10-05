import { PERSONAL_TODAY_WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { observeRpcEffect, observeRpcStream } from "../../observability/RpcInstrumentation.ts";
import type * as PersonalToday from "./PersonalTodayService.ts";

const trace = { "rpc.aggregate": "personalToday" } as const;

/** Thin WebSocket handlers for the Today hub, spread into `ws.ts`. */
export function makePersonalTodayRpcHandlers(today: PersonalToday.PersonalTodayService["Service"]) {
  return {
    [PERSONAL_TODAY_WS_METHODS.subscribe]: (_input: {}) =>
      observeRpcStream(PERSONAL_TODAY_WS_METHODS.subscribe, today.subscribe(), trace),
    [PERSONAL_TODAY_WS_METHODS.subscribeBriefs]: (_input: {}) =>
      observeRpcStream(PERSONAL_TODAY_WS_METHODS.subscribeBriefs, today.subscribeBriefs(), trace),
    [PERSONAL_TODAY_WS_METHODS.refresh]: (_input: {}) =>
      observeRpcEffect(PERSONAL_TODAY_WS_METHODS.refresh, today.refresh(), trace),
    [PERSONAL_TODAY_WS_METHODS.taskAction]: (input: Parameters<typeof today.taskAction>[0]) =>
      observeRpcEffect(PERSONAL_TODAY_WS_METHODS.taskAction, today.taskAction(input), trace),
    [PERSONAL_TODAY_WS_METHODS.routineAction]: (input: Parameters<typeof today.routineAction>[0]) =>
      observeRpcEffect(
        PERSONAL_TODAY_WS_METHODS.routineAction,
        today.routineAction(input).pipe(Effect.as({})),
        trace,
      ),
    [PERSONAL_TODAY_WS_METHODS.routineHistory]: (
      input: Parameters<typeof today.routineHistory>[0],
    ) =>
      observeRpcEffect(
        PERSONAL_TODAY_WS_METHODS.routineHistory,
        today.routineHistory(input),
        trace,
      ),
    [PERSONAL_TODAY_WS_METHODS.pendingPrompts]: (
      input: Parameters<typeof today.pendingPrompts>[0],
    ) =>
      observeRpcEffect(
        PERSONAL_TODAY_WS_METHODS.pendingPrompts,
        today.pendingPrompts(input),
        trace,
      ),
    [PERSONAL_TODAY_WS_METHODS.updateSettings]: (
      input: Parameters<typeof today.updateSettings>[0],
    ) =>
      observeRpcEffect(
        PERSONAL_TODAY_WS_METHODS.updateSettings,
        today.updateSettings(input),
        trace,
      ),
  };
}
