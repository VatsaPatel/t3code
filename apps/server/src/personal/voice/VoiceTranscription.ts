// @effect-diagnostics nodeBuiltinImport:off
import * as NodeBuffer from "node:buffer";

import {
  PERSONAL_VOICE_MAX_AUDIO_BYTES,
  PERSONAL_VOICE_MAX_DURATION_MS,
  PersonalVoiceEmptyTranscriptError,
  PersonalVoiceEngineError,
  PersonalVoiceInvalidAudioError,
  PersonalVoiceNotConfiguredError,
  PersonalVoiceTimeoutError,
  type PersonalVoiceStatusResult,
  type PersonalVoiceTranscribeInput,
  type PersonalVoiceTranscribeResult,
} from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../../config.ts";
import { expandHomePathWith } from "../../pathExpansion.ts";
import * as ProcessRunner from "../../processRunner.ts";

const SETTINGS_FILE_NAME = "personal-voice-settings.json";

const DEFAULT_SETTINGS = {
  command: "~/.hermes/bin/azure-mai-speech",
  args: [
    "transcribe",
    "--input",
    "{input}",
    "--output",
    "{output}",
    "--model",
    "{model}",
    "--language",
    "{language}",
  ],
  envFile: "~/.config/hermes/azure-speech.env",
  model: "MAI-Transcribe-2",
  language: "auto",
  timeoutMs: 120_000,
} as const;

/**
 * Optional overrides in `<userdata>/personal-voice-settings.json`. `args` may use the
 * placeholders `{input}`, `{output}`, `{model}` and `{language}`; there is no shell, so
 * values are always passed as single arguments. `envFile: null` means the engine needs no env.
 */
const PersonalVoiceSettingsFile = Schema.Struct({
  command: Schema.optionalKey(Schema.String),
  args: Schema.optionalKey(Schema.Array(Schema.String)),
  envFile: Schema.optionalKey(Schema.NullOr(Schema.String)),
  model: Schema.optionalKey(Schema.String),
  language: Schema.optionalKey(Schema.String),
  timeoutMs: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1000, maximum: 600_000 })),
  ),
});
const decodeSettingsFile = Schema.decodeUnknownOption(
  Schema.fromJsonString(PersonalVoiceSettingsFile),
);

const LANGUAGE_PATTERN = /^(auto|[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*)$/;
const STDERR_TAIL_CHARS = 600;
const MIN_REDACTED_SECRET_LENGTH = 4;

const AUDIO_EXTENSIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/webm/i, ".webm"],
  [/ogg|opus/i, ".ogg"],
  [/mp4|m4a|aac/i, ".m4a"],
  [/wav|wave/i, ".wav"],
  [/mpeg|mp3/i, ".mp3"],
  [/flac/i, ".flac"],
];

const audioExtensionFor = (mimeType: string) =>
  AUDIO_EXTENSIONS.find(([pattern]) => pattern.test(mimeType))?.[1] ?? ".bin";

/** Parses `KEY=VALUE` lines; blank lines and `#` comments are skipped. Values are never logged. */
export function parseEnvFile(content: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2] ?? "";
    if (/^(['"]).*\1$/.test(value) && value.length >= 2) value = value.slice(1, -1);
    env[match[1]!] = value;
  }
  return env;
}

/** Last lines of engine stderr with secrets removed: env-file values and key-like assignments. */
export function redactedStderrTail(stderr: string, secrets: ReadonlyArray<string>): string {
  let text = stderr;
  for (const secret of secrets) {
    if (secret.length >= MIN_REDACTED_SECRET_LENGTH) text = text.split(secret).join("***");
  }
  text = text.replace(
    /((?:key|token|secret|password|authorization)["'\s:=]+)[A-Za-z0-9+/_\-.]{12,}/gi,
    "$1***",
  );
  text = text.replace(/\s+/g, " ").trim();
  return text.length > STDERR_TAIL_CHARS ? `…${text.slice(-STDERR_TAIL_CHARS)}` : text;
}

export class VoiceTranscription extends Context.Service<
  VoiceTranscription,
  {
    readonly status: Effect.Effect<PersonalVoiceStatusResult>;
    readonly transcribe: (
      input: PersonalVoiceTranscribeInput,
    ) => Effect.Effect<
      PersonalVoiceTranscribeResult,
      | PersonalVoiceNotConfiguredError
      | PersonalVoiceInvalidAudioError
      | PersonalVoiceEngineError
      | PersonalVoiceTimeoutError
      | PersonalVoiceEmptyTranscriptError
    >;
  }
>()("t3/personal/voice/VoiceTranscription") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const hostEnvironment = yield* HostProcessEnvironment;

  const settingsPath = path.join(config.stateDir, SETTINGS_FILE_NAME);

  const loadSettings = Effect.gen(function* () {
    const content = yield* fileSystem.readFileString(settingsPath).pipe(Effect.option);
    const overrides = Option.isNone(content) ? Option.some({}) : decodeSettingsFile(content.value);
    if (Option.isNone(overrides)) {
      return yield* new PersonalVoiceNotConfiguredError({
        reason: `${SETTINGS_FILE_NAME} is not valid`,
      });
    }
    const merged = { ...DEFAULT_SETTINGS, ...overrides.value };
    return {
      command: expandHomePathWith(merged.command, path),
      args: merged.args,
      envFile: merged.envFile === null ? null : expandHomePathWith(merged.envFile, path),
      model: merged.model,
      language: merged.language,
      timeoutMs: merged.timeoutMs,
    };
  });

  const isExecutableFile = (candidate: string) =>
    fileSystem.stat(candidate).pipe(
      Effect.map((info) => info.type === "File" && (info.mode & 0o111) !== 0),
      Effect.orElseSucceed(() => false),
    );

  const commandResolves = Effect.fn("VoiceTranscription.commandResolves")(function* (
    command: string,
  ) {
    if (path.isAbsolute(command) || command.includes("/")) return yield* isExecutableFile(command);
    for (const directory of (hostEnvironment.PATH ?? "").split(path.sep === "\\" ? ";" : ":")) {
      if (directory && (yield* isExecutableFile(path.join(directory, command)))) return true;
    }
    return false;
  });

  /** The reason the engine cannot run, or null when it can. Never reads secret values. */
  const unavailableReason = Effect.fn("VoiceTranscription.unavailableReason")(function* (
    settings: Effect.Success<typeof loadSettings>,
  ) {
    if (!(yield* commandResolves(settings.command))) {
      return `the speech command ${settings.command} was not found`;
    }
    if (
      settings.envFile !== null &&
      !(yield* fileSystem.exists(settings.envFile).pipe(Effect.orElseSucceed(() => false)))
    ) {
      return `the credentials file ${settings.envFile} was not found`;
    }
    return null;
  });

  const status: VoiceTranscription["Service"]["status"] = loadSettings.pipe(
    Effect.flatMap((settings) =>
      unavailableReason(settings).pipe(
        Effect.map((reason): PersonalVoiceStatusResult => ({
          configured: reason === null,
          engine: "command",
          model: settings.model,
          ...(reason === null ? {} : { reason }),
          maxAudioBytes: PERSONAL_VOICE_MAX_AUDIO_BYTES,
          maxDurationMs: PERSONAL_VOICE_MAX_DURATION_MS,
        })),
      ),
    ),
    Effect.catchTag("PersonalVoiceNotConfiguredError", (error) =>
      Effect.succeed<PersonalVoiceStatusResult>({
        configured: false,
        engine: "command",
        reason: error.reason,
        maxAudioBytes: PERSONAL_VOICE_MAX_AUDIO_BYTES,
        maxDurationMs: PERSONAL_VOICE_MAX_DURATION_MS,
      }),
    ),
  );

  const transcribe: VoiceTranscription["Service"]["transcribe"] = Effect.fn(
    "VoiceTranscription.transcribe",
  )(function* (input) {
    const settings = yield* loadSettings;
    const reason = yield* unavailableReason(settings);
    if (reason !== null) return yield* new PersonalVoiceNotConfiguredError({ reason });

    const language = input.language ?? settings.language;
    if (!LANGUAGE_PATTERN.test(language)) {
      return yield* new PersonalVoiceInvalidAudioError({ reason: "the language is not valid" });
    }
    if ((input.durationMs ?? 0) > PERSONAL_VOICE_MAX_DURATION_MS) {
      return yield* new PersonalVoiceInvalidAudioError({
        reason: `recordings are limited to ${PERSONAL_VOICE_MAX_DURATION_MS / 60_000} minutes`,
      });
    }
    // Reject by encoded length first so an oversized payload is never decoded.
    if (Math.floor((input.audioBase64.length * 3) / 4) > PERSONAL_VOICE_MAX_AUDIO_BYTES) {
      return yield* new PersonalVoiceInvalidAudioError({
        reason: `recordings are limited to ${PERSONAL_VOICE_MAX_AUDIO_BYTES / (1024 * 1024)} MB`,
      });
    }
    const audio = NodeBuffer.Buffer.from(input.audioBase64, "base64");
    if (audio.byteLength === 0) {
      return yield* new PersonalVoiceInvalidAudioError({ reason: "the recording is empty" });
    }

    const fileEnv = settings.envFile
      ? parseEnvFile(
          yield* fileSystem.readFileString(settings.envFile).pipe(
            Effect.mapError(
              () =>
                new PersonalVoiceNotConfiguredError({
                  reason: `the credentials file ${settings.envFile} cannot be read`,
                }),
            ),
          ),
        )
      : {};
    const secrets = Object.values(fileEnv);
    const startedAt = yield* Clock.currentTimeMillis;

    // The scope owns the private temp directory, so success, failure, timeout and
    // cancellation all remove the recording and the transcript file.
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* fileSystem
          .makeTempDirectoryScoped({ prefix: "t3-voice-" })
          .pipe(Effect.orDie);
        const inputPath = path.join(directory, `input${audioExtensionFor(input.mimeType)}`);
        const outputPath = path.join(directory, "transcript.txt");
        yield* fileSystem.writeFile(inputPath, audio).pipe(Effect.orDie);

        const values: Record<string, string> = {
          "{input}": inputPath,
          "{output}": outputPath,
          "{model}": settings.model,
          "{language}": language,
        };
        const args = settings.args.map((arg) => values[arg] ?? arg);
        const usesOutputFile = settings.args.includes("{output}");

        const result = yield* processRunner
          .run({
            command: settings.command,
            args,
            cwd: directory,
            env: fileEnv,
            timeout: settings.timeoutMs,
          })
          .pipe(
            Effect.catchTags({
              ProcessTimeoutError: () =>
                Effect.fail(new PersonalVoiceTimeoutError({ timeoutMs: settings.timeoutMs })),
              ProcessSpawnError: () =>
                Effect.fail(
                  new PersonalVoiceEngineError({
                    detail: "the speech command could not be started",
                    exitCode: null,
                  }),
                ),
              ProcessStdinError: () =>
                Effect.fail(new PersonalVoiceEngineError({ detail: "", exitCode: null })),
              ProcessOutputLimitError: () =>
                Effect.fail(
                  new PersonalVoiceEngineError({
                    detail: "the speech command produced too much output",
                    exitCode: null,
                  }),
                ),
              ProcessReadError: () =>
                Effect.fail(new PersonalVoiceEngineError({ detail: "", exitCode: null })),
            }),
          );

        if (result.code !== 0) {
          return yield* new PersonalVoiceEngineError({
            detail: redactedStderrTail(result.stderr || result.stdout, secrets),
            exitCode: result.code,
          });
        }

        const fromFile = usesOutputFile
          ? yield* fileSystem.readFileString(outputPath).pipe(Effect.orElseSucceed(() => ""))
          : "";
        const text = (fromFile || result.stdout).trim();
        if (!text) return yield* new PersonalVoiceEmptyTranscriptError();

        const finishedAt = yield* Clock.currentTimeMillis;
        return {
          text,
          model: settings.model,
          elapsedMs: Math.max(0, finishedAt - startedAt),
        } satisfies PersonalVoiceTranscribeResult;
      }),
    );
  });

  return VoiceTranscription.of({ status, transcribe });
});

export const layer = Layer.effect(VoiceTranscription, make);
