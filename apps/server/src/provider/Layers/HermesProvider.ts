/**
 * HermesProvider — snapshot/probe layer for Hermes Agent.
 *
 * The probe never creates sessions or sends prompts: it checks that the agent
 * checkout and interpreter exist, reads the installed version from
 * `install-stamp.json`, and asks the instance gateway for `gateway.ready`,
 * `gateway.capabilities`, and the read-only `model.options` inventory.
 *
 * Model slugs are `<hermes provider slug>::<model id>` (provider slugs can
 * contain `:`). `default` keeps the model configured for the Hermes profile.
 */
import {
  type CustomModelSetting,
  type HermesSettings,
  type ModelCapabilities,
  type ProviderOptionChoice,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  HERMES_DEFAULT_MODEL_SLUG,
  HERMES_FAST_OPTION_ID,
  HERMES_MODEL_SLUG_SEPARATOR,
  HERMES_REASONING_OPTION_ID,
} from "../../orchestration-v2/Adapters/HermesAdapterV2.ts";
import type { HermesGateway } from "../hermes/HermesGateway.ts";
import {
  HermesGatewayCapabilitiesResult,
  HermesModelOptionsResult,
  type HermesModelOptionsResult as HermesModelOptions,
} from "../hermes/HermesProtocol.ts";
import {
  buildServerProvider,
  providerModelsFromSettings,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

const HERMES_PRESENTATION = {
  displayName: "Hermes",
  showInteractionModeToggle: false,
  // Full access turns on Hermes' per-session yolo; Supervised defers to the
  // profile's own approvals.mode.
  supportedRuntimeModes: ["approval-required", "full-access"],
  reportsContextWindow: true,
  requiresNewThreadForModelChange: false,
  supportsConversationRollback: false,
} as const;

const MODEL_OPTIONS_TIMEOUT_MS = 60_000;

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });

const REASONING_LEVELS: ReadonlyArray<ProviderOptionChoice> = [
  { id: "minimal", label: "Minimal" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "Extra High" },
  { id: "max", label: "Max" },
];

function hermesModelCapabilities(input: {
  readonly reasoning: boolean;
  readonly canDisableReasoning: boolean;
  readonly fast: boolean;
}): ModelCapabilities {
  return createModelCapabilities({
    optionDescriptors: [
      ...(input.reasoning
        ? [
            {
              id: HERMES_REASONING_OPTION_ID,
              label: "Reasoning",
              type: "select" as const,
              options: [
                ...(input.canDisableReasoning ? [{ id: "none", label: "Off" }] : []),
                ...REASONING_LEVELS,
              ],
            },
          ]
        : []),
      ...(input.fast
        ? [{ id: HERMES_FAST_OPTION_ID, label: "Fast mode", type: "boolean" as const }]
        : []),
    ],
  });
}

/** Turn a `model.options` inventory into T3 models, the profile default first. */
export function hermesModelsFromOptions(
  options: HermesModelOptions | undefined,
  customModels: ReadonlyArray<CustomModelSetting>,
): ReadonlyArray<ServerProviderModel> {
  const defaultName =
    options?.model != null && options.model !== ""
      ? `Hermes default (${options.model})`
      : "Hermes default";
  const builtIn: Array<ServerProviderModel> = [
    {
      slug: HERMES_DEFAULT_MODEL_SLUG,
      name: defaultName,
      isCustom: false,
      isDefault: true,
      capabilities: EMPTY_CAPABILITIES,
    },
  ];
  const seen = new Set([HERMES_DEFAULT_MODEL_SLUG]);
  for (const provider of options?.providers ?? []) {
    if (provider.authenticated === false) continue;
    for (const model of provider.models ?? []) {
      const slug = `${provider.slug}${HERMES_MODEL_SLUG_SEPARATOR}${model}`;
      if (seen.has(slug)) continue;
      seen.add(slug);
      const capabilities = provider.capabilities?.[model];
      builtIn.push({
        slug,
        name: model,
        subProvider: provider.name,
        isCustom: false,
        capabilities:
          capabilities == null
            ? EMPTY_CAPABILITIES
            : hermesModelCapabilities({
                reasoning: capabilities.reasoning === true,
                canDisableReasoning: capabilities.can_disable_reasoning === true,
                fast: capabilities.fast === true,
              }),
      });
    }
  }
  return providerModelsFromSettings(builtIn, customModels, EMPTY_CAPABILITIES);
}

const InstallStamp = Schema.Struct({
  baseVersion: Schema.optional(Schema.String),
  displayVersion: Schema.optional(Schema.String),
});
const decodeInstallStamp = Schema.decodeUnknownOption(Schema.fromJsonString(InstallStamp));
const decodeModelOptions = Schema.decodeUnknownOption(HermesModelOptionsResult);
const decodeCapabilities = Schema.decodeUnknownOption(HermesGatewayCapabilitiesResult);

const readHermesVersion = (fileSystem: FileSystem.FileSystem, path: Path.Path, agentRoot: string) =>
  fileSystem.readFileString(path.join(agentRoot, "install-stamp.json")).pipe(
    Effect.map((text) => {
      const stamp = decodeInstallStamp(text);
      return Option.isSome(stamp) ? (stamp.value.baseVersion ?? null) : null;
    }),
    Effect.orElseSucceed(() => null),
  );

export function buildInitialHermesProviderSnapshot(
  settings: HermesSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    return {
      ...buildServerProvider({
        presentation: HERMES_PRESENTATION,
        enabled: settings.enabled,
        checkedAt,
        models: hermesModelsFromOptions(undefined, settings.customModels),
        probe: {
          installed: settings.enabled,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: settings.enabled
            ? "Checking Hermes Agent..."
            : "Hermes is disabled in T3 Code settings.",
        },
      }),
      supportsTextGeneration: false,
    };
  });
}

export const checkHermesProviderStatus = Effect.fn("checkHermesProviderStatus")(function* (
  settings: HermesSettings,
  gateway: HermesGateway,
): Effect.fn.Return<ServerProviderDraft, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = hermesModelsFromOptions(undefined, settings.customModels);
  const draft = (
    probe: Parameters<typeof buildServerProvider>[0]["probe"],
    models: ReadonlyArray<ServerProviderModel> = fallbackModels,
  ): ServerProviderDraft => ({
    ...buildServerProvider({
      presentation: HERMES_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models,
      probe,
    }),
    // Hermes has no tool-free one-shot completion; hidden sessions would spend
    // tokens and pollute the user's session list.
    supportsTextGeneration: false,
  });

  if (!settings.enabled) {
    return draft({
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "Hermes is disabled in T3 Code settings.",
    });
  }

  const { launch } = gateway;
  const installed = yield* Effect.all([
    fileSystem.exists(launch.command),
    fileSystem.exists(path.join(launch.agentRoot, "tui_gateway")),
    fileSystem.exists(launch.profileHome),
  ]).pipe(Effect.orElseSucceed(() => [false, false, false] as const));
  if (!installed[0] || !installed[1]) {
    return draft({
      installed: false,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: `Hermes Agent was not found at ${launch.agentRoot}. Install it from https://hermes-agent.nousresearch.com or set the Hermes home in settings.`,
    });
  }
  if (!installed[2]) {
    return draft({
      installed: true,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: `Hermes profile home ${launch.profileHome} does not exist.`,
    });
  }

  const version = yield* readHermesVersion(fileSystem, path, launch.agentRoot);
  const probe = yield* Effect.gen(function* () {
    const connection = yield* gateway.connection;
    const capabilities = decodeCapabilities(
      yield* connection.request("gateway.capabilities", {}, { timeoutMs: 15_000 }),
    );
    const options = yield* connection
      .request("model.options", {}, { timeoutMs: MODEL_OPTIONS_TIMEOUT_MS })
      .pipe(Effect.map(decodeModelOptions), Effect.orElseSucceed(Option.none));
    return { capabilities, options };
  }).pipe(Effect.ensuring(gateway.touch), Effect.exit);

  if (Exit.isFailure(probe)) {
    yield* Effect.logWarning("Hermes gateway probe failed.", {
      errorTag: causeErrorTag(probe.cause),
    });
    return draft({
      installed: true,
      version,
      status: "error",
      auth: { status: "unknown" },
      message:
        "Hermes Agent is installed, but its gateway failed to start. Run `hermes doctor` in a terminal.",
    });
  }
  const options = probe.value.options;
  const models = hermesModelsFromOptions(Option.getOrUndefined(options), settings.customModels);
  const authenticated = Option.isSome(options)
    ? options.value.providers.some((provider) => provider.authenticated !== false)
    : null;
  if (
    Option.isSome(probe.value.capabilities) &&
    probe.value.capabilities.value.per_session_exclusive_submit !== true
  ) {
    yield* Effect.logInfo("Hermes gateway does not advertise exclusive session submit.");
  }
  return draft(
    {
      installed: true,
      version,
      status: authenticated === false ? "warning" : "ready",
      auth:
        authenticated === null
          ? { status: "unknown" }
          : { status: authenticated ? "authenticated" : "unauthenticated", type: "hermes" },
      ...(authenticated === false
        ? { message: "Hermes has no signed-in model provider. Run `hermes setup` in a terminal." }
        : Option.isNone(options)
          ? { message: "Hermes is available, but T3 Code could not read its model list." }
          : {}),
    },
    models,
  );
});
