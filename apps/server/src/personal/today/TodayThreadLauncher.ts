import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type ModelSelection,
  type ServerProvider,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ThreadLaunchService from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ManagedProjectFolders from "../../project/ManagedProjectFolders.ts";
import * as ProviderRegistry from "../../provider/Services/ProviderRegistry.ts";

/** Hermes' default provider instance id and driver kind, shared across the personal fork. */
const HERMES_INSTANCE_ID = "hermes";
const HERMES_DRIVER = "hermes";

export class TodayThreadLaunchError extends Schema.TaggedError<TodayThreadLaunchError>()(
  "TodayThreadLaunchError",
  {
    reason: Schema.Literals(["no-provider", "no-scratch-project", "launch-failed"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "no-provider":
        return "No Hermes provider is configured on this machine, and no fallback model was given.";
      case "no-scratch-project":
        return "This machine has no place for threads without a project.";
      case "launch-failed":
        return "Could not start the agent thread.";
    }
  }
}

/**
 * The Hermes instance to hand work to: the default `hermes` instance, else
 * any enabled instance of the Hermes driver. Returns null without one.
 */
function selectHermesModel(providers: ReadonlyArray<ServerProvider>): ModelSelection | null {
  const candidates = providers.filter(
    (provider) =>
      provider.enabled &&
      provider.availability !== "unavailable" &&
      (provider.instanceId === HERMES_INSTANCE_ID || provider.driver === HERMES_DRIVER),
  );
  const provider =
    candidates.find((candidate) => candidate.instanceId === HERMES_INSTANCE_ID) ?? candidates[0];
  const model = provider?.models[0]?.slug;
  return provider === undefined || model === undefined
    ? null
    : { instanceId: provider.instanceId, model };
}

/** Starts agent threads for Today: delegated to-dos land in the "No project" scratch project. */
export class TodayThreadLauncher extends Context.Service<
  TodayThreadLauncher,
  {
    readonly launch: (input: {
      readonly title: string;
      readonly prompt: string;
      readonly fallbackModelSelection?: ModelSelection | undefined;
    }) => Effect.Effect<ThreadId, TodayThreadLaunchError>;
  }
>()("t3/personal/today/TodayThreadLauncher") {}

const make = Effect.gen(function* () {
  const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;
  const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const crypto = yield* Crypto.Crypto;

  const launch: TodayThreadLauncher["Service"]["launch"] = (input) =>
    Effect.gen(function* () {
      const providers = yield* providerRegistry.getProviders;
      const modelSelection = selectHermesModel(providers) ?? input.fallbackModelSelection;
      if (modelSelection === undefined) {
        return yield* new TodayThreadLaunchError({ reason: "no-provider" });
      }
      const { projectId } = yield* folders.ensureScratchProject.pipe(
        Effect.mapError(
          (cause) => new TodayThreadLaunchError({ reason: "no-scratch-project", cause }),
        ),
      );
      const id = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
      const result = yield* threadLaunch
        .launch({
          commandId: CommandId.make(`personal-today:launch:${id}`),
          projectId,
          title: input.title,
          modelSelection,
          runtimeMode: DEFAULT_RUNTIME_MODE,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          workspaceStrategy: { type: "root" },
          initialMessage: { text: input.prompt, attachments: [] },
          createdBy: "user",
          creationSource: "server",
        })
        .pipe(
          Effect.mapError(
            (cause) => new TodayThreadLaunchError({ reason: "launch-failed", cause }),
          ),
        );
      return result.threadId;
    });

  return TodayThreadLauncher.of({ launch });
});

export const layer = Layer.effect(TodayThreadLauncher, make);
