/**
 * PersonalSettings - settings for the personal-fork features, kept in their own
 * JSON file (`<stateDir>/personal-settings.json`) so upstream ServerSettings
 * never changes shape.
 *
 * Unknown top-level keys are preserved on write, so other personal features can
 * add their own sections to the same file without this module knowing them.
 *
 * @module personal/PersonalSettings
 */
import {
  DEFAULT_PERSONAL_SETTINGS,
  PersonalSettings as PersonalSettingsSchema,
  PersonalSyncError,
  type PersonalSettingsPatch,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import * as ServerConfig from "../config.ts";

const JsonText = Schema.fromJsonString(Schema.Unknown);
const decodeJsonText = Schema.decodeUnknownOption(JsonText);
const encodeJsonText = Schema.encodeSync(JsonText);
const decodeSettings = Schema.decodeUnknownOption(PersonalSettingsSchema);
const encodeSettings = Schema.encodeSync(PersonalSettingsSchema);
const parseJsonObject = (text: string): Record<string, unknown> => {
  const parsed = Option.getOrNull(decodeJsonText(text));
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
};

export class PersonalSettings extends Context.Service<
  PersonalSettings,
  {
    readonly get: Effect.Effect<PersonalSettingsSchema>;
    readonly update: (
      patch: PersonalSettingsPatch,
    ) => Effect.Effect<PersonalSettingsSchema, PersonalSyncError>;
  }
>()("t3/personal/PersonalSettings") {}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const filePath = path.join(config.stateDir, "personal-settings.json");
  const writeLock = yield* Semaphore.make(1);

  const readRaw = fileSystem.readFileString(filePath).pipe(
    Effect.map(parseJsonObject),
    Effect.orElseSucceed((): Record<string, unknown> => ({})),
  );
  const fromRaw = (raw: Record<string, unknown>) =>
    Option.getOrElse(decodeSettings(raw), () => DEFAULT_PERSONAL_SETTINGS);

  const current = yield* Ref.make(fromRaw(yield* readRaw));

  const update: PersonalSettings["Service"]["update"] = (patch) =>
    Effect.gen(function* () {
      // Re-read so keys written by other personal features since startup survive.
      const raw = yield* readRaw;
      const previous = fromRaw(raw);
      const next = fromRaw({
        ...raw,
        sync: {
          ...encodeSettings(previous).sync,
          ...Object.fromEntries(
            Object.entries(patch.sync ?? {}).filter(([, value]) => value !== undefined),
          ),
        },
      });
      const contents = `${encodeJsonText({ ...raw, ...encodeSettings(next) })}\n`;
      yield* writeFileStringAtomically({ filePath, contents }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.mapError(
          (cause) => new PersonalSyncError({ message: "Could not save personal settings.", cause }),
        ),
      );
      yield* Ref.set(current, next);
      return next;
    }).pipe(writeLock.withPermits(1));

  return PersonalSettings.of({ get: Ref.get(current), update });
});

export const layer = Layer.effect(PersonalSettings, make);
