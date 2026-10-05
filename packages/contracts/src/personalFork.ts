import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { OrchestrationV2CreationSource } from "./orchestrationV2.ts";

/**
 * Forks a whole thread at its current head. Threads with T3 runs use the
 * orchestrator's own `thread.fork`; threads whose history came from another
 * client (synced Codex/Claude/Hermes sessions) are forked through the provider's
 * native fork, so the child keeps the provider's compacted context.
 */
export const PersonalThreadForkInput = Schema.Struct({
  sourceThreadId: ThreadId,
  targetThreadId: ThreadId,
  title: Schema.optional(TrimmedNonEmptyString),
  creationSource: Schema.optional(OrchestrationV2CreationSource),
});
export type PersonalThreadForkInput = typeof PersonalThreadForkInput.Type;

export const PersonalThreadForkResult = Schema.Struct({
  threadId: ThreadId,
  /** `native` means the provider created the child session; `orchestrated` defers to `thread.fork`. */
  mode: Schema.Literals(["native", "orchestrated"]),
});
export type PersonalThreadForkResult = typeof PersonalThreadForkResult.Type;

export class PersonalThreadForkError extends Schema.TaggedError<PersonalThreadForkError>()(
  "PersonalThreadForkError",
  {
    sourceThreadId: ThreadId,
    reason: Schema.Literals([
      "not-found",
      "busy",
      "no-native-session",
      "unsupported",
      "provider-failed",
    ]),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}
