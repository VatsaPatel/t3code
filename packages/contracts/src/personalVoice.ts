/**
 * Environment-backed dictation: the web composer records audio, the environment runs the
 * user's speech-to-text command, and the transcript comes back as text for the draft.
 */
import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const PERSONAL_VOICE_WS_METHODS = {
  status: "personal.voice.status",
  transcribe: "personal.voice.transcribe",
} as const;

export const PERSONAL_VOICE_MAX_AUDIO_BYTES = 25 * 1024 * 1024;
export const PERSONAL_VOICE_MAX_DURATION_MS = 10 * 60_000;

export const PersonalVoiceStatusInput = Schema.Struct({});
export type PersonalVoiceStatusInput = typeof PersonalVoiceStatusInput.Type;

export const PersonalVoiceStatusResult = Schema.Struct({
  configured: Schema.Boolean,
  /** Only `command` exists today: the environment runs a local speech-to-text command. */
  engine: Schema.Literal("command"),
  model: Schema.optionalKey(Schema.String),
  /** Why the engine is not usable, safe to show to the user. */
  reason: Schema.optionalKey(Schema.String),
  maxAudioBytes: NonNegativeInt,
  maxDurationMs: NonNegativeInt,
});
export type PersonalVoiceStatusResult = typeof PersonalVoiceStatusResult.Type;

export const PersonalVoiceTranscribeInput = Schema.Struct({
  /** Base64 audio bytes, at most `PERSONAL_VOICE_MAX_AUDIO_BYTES` once decoded. */
  audioBase64: Schema.String.check(Schema.isMinLength(1)),
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  /** BCP 47 tag such as `en-US`; omitted lets the engine detect the language. */
  language: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(35))),
  durationMs: Schema.optionalKey(NonNegativeInt),
});
export type PersonalVoiceTranscribeInput = typeof PersonalVoiceTranscribeInput.Type;

export const PersonalVoiceTranscribeResult = Schema.Struct({
  text: Schema.String,
  model: Schema.optionalKey(Schema.String),
  elapsedMs: NonNegativeInt,
});
export type PersonalVoiceTranscribeResult = typeof PersonalVoiceTranscribeResult.Type;

export class PersonalVoiceNotConfiguredError extends Schema.TaggedError<PersonalVoiceNotConfiguredError>()(
  "PersonalVoiceNotConfiguredError",
  { reason: Schema.String },
) {
  override get message(): string {
    return `Voice transcription is not configured: ${this.reason}`;
  }
}

export class PersonalVoiceInvalidAudioError extends Schema.TaggedError<PersonalVoiceInvalidAudioError>()(
  "PersonalVoiceInvalidAudioError",
  { reason: Schema.String },
) {
  override get message(): string {
    return `The recording cannot be transcribed: ${this.reason}`;
  }
}

export class PersonalVoiceEngineError extends Schema.TaggedError<PersonalVoiceEngineError>()(
  "PersonalVoiceEngineError",
  {
    /** Redacted tail of the engine's stderr. */
    detail: Schema.String,
    exitCode: Schema.NullOr(Schema.Int),
  },
) {
  override get message(): string {
    return this.detail
      ? `The transcription engine failed: ${this.detail}`
      : "The transcription engine failed.";
  }
}

export class PersonalVoiceTimeoutError extends Schema.TaggedError<PersonalVoiceTimeoutError>()(
  "PersonalVoiceTimeoutError",
  { timeoutMs: NonNegativeInt },
) {
  override get message(): string {
    return `Transcription timed out after ${Math.round(this.timeoutMs / 1000)}s.`;
  }
}

export class PersonalVoiceEmptyTranscriptError extends Schema.TaggedError<PersonalVoiceEmptyTranscriptError>()(
  "PersonalVoiceEmptyTranscriptError",
  {},
) {
  override get message(): string {
    return "No speech was detected in the recording.";
  }
}

export const PersonalVoiceTranscribeError = Schema.Union([
  PersonalVoiceNotConfiguredError,
  PersonalVoiceInvalidAudioError,
  PersonalVoiceEngineError,
  PersonalVoiceTimeoutError,
  PersonalVoiceEmptyTranscriptError,
]);
export type PersonalVoiceTranscribeError = typeof PersonalVoiceTranscribeError.Type;
