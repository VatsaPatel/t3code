import {
  PERSONAL_VOICE_WS_METHODS,
  type EnvironmentId,
  type PersonalVoiceTranscribeInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { AtomRegistry, Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { request } from "../rpc/client.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  runAtomCommand,
  squashAtomCommandFailure,
} from "../state/runtime.ts";
import {
  throwIfVoiceTranscriptionAborted,
  VoiceTranscriptionError,
  type VoiceTranscriber,
} from "../voice-input/transcription.ts";

const STATUS_STALE_TIME_MS = 60_000;

/**
 * Environment-backed dictation RPCs: the environment runs the user's speech-to-text command,
 * so every client that can record audio can transcribe. Instantiated per client with its own
 * connection runtime, like `createAttachmentEnvironmentAtoms`.
 */
export function createPersonalVoiceEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  // The command layer has no cancellation input, so a caller's AbortSignal travels beside the
  // payload object. Aborting interrupts the RPC, which makes the server stop the engine process.
  const abortSignals = new WeakMap<object, AbortSignal>();

  const status = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:personal-voice:status",
    tag: PERSONAL_VOICE_WS_METHODS.status,
    staleTimeMs: STATUS_STALE_TIME_MS,
  });

  const transcribe = createEnvironmentRpcCommand(runtime, {
    label: "environment-command:personal-voice:transcribe",
    tag: PERSONAL_VOICE_WS_METHODS.transcribe,
    execute: (input) => {
      const signal = abortSignals.get(input);
      const call = request(PERSONAL_VOICE_WS_METHODS.transcribe, input);
      if (!signal) return call;
      return call.pipe(
        Effect.raceFirst(
          Effect.callback<never>((resume) => {
            if (signal.aborted) return resume(Effect.interrupt);
            const onAbort = () => resume(Effect.interrupt);
            signal.addEventListener("abort", onAbort, { once: true });
            return Effect.sync(() => signal.removeEventListener("abort", onAbort));
          }),
        ),
      );
    },
  });

  return { status, transcribe, abortSignals };
}

type PersonalVoiceAtoms = ReturnType<typeof createPersonalVoiceEnvironmentAtoms>;

/** What the failed RPC means to the person dictating. Tags come from the server's contract. */
export function personalVoiceFailureMessage(error: unknown): string {
  const tagged =
    typeof error === "object" && error !== null ? (error as Record<string, unknown>) : {};
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  switch (tagged._tag) {
    case "PersonalVoiceNotConfiguredError":
      return `Voice transcription is not set up on this environment. ${text(tagged.reason)}`.trim();
    case "PersonalVoiceInvalidAudioError":
      return `The recording cannot be transcribed: ${text(tagged.reason)}`;
    case "PersonalVoiceEngineError":
      return text(tagged.detail)
        ? `The transcription engine failed: ${text(tagged.detail)}`
        : "The transcription engine failed.";
    case "PersonalVoiceTimeoutError":
      return "Transcription timed out.";
    case "PersonalVoiceEmptyTranscriptError":
      return "No speech was detected.";
    case "EnvironmentRpcUnavailableError":
      return "The environment is not connected.";
    default:
      return "Could not transcribe this recording.";
  }
}

export interface RecordedAudio {
  readonly base64: string;
  readonly mimeType: string;
  readonly durationMs?: number;
}

/**
 * A `VoiceTranscriber` that sends the recording to the environment. `readRecording` turns the
 * recorder's URI into bytes, which is the only platform-specific step.
 */
export function createEnvironmentVoiceTranscriber(input: {
  readonly registry: AtomRegistry.AtomRegistry;
  readonly atoms: Pick<PersonalVoiceAtoms, "transcribe" | "abortSignals">;
  readonly environmentId: EnvironmentId;
  readonly locale: string;
  readonly readRecording: (uri: string, signal: AbortSignal) => Promise<RecordedAudio>;
}): VoiceTranscriber {
  return {
    prepare: async ({ signal }) => {
      throwIfVoiceTranscriptionAborted(signal);
      return {
        locale: input.locale,
        transcribe: async (uri, { signal: transcribeSignal }) => {
          const audio = await input.readRecording(uri, transcribeSignal);
          throwIfVoiceTranscriptionAborted(transcribeSignal);
          const payload: PersonalVoiceTranscribeInput = {
            audioBase64: audio.base64,
            mimeType: audio.mimeType,
            ...(audio.durationMs === undefined ? {} : { durationMs: audio.durationMs }),
          };
          input.atoms.abortSignals.set(payload, transcribeSignal);
          const result = await runAtomCommand(
            input.registry,
            input.atoms.transcribe,
            { environmentId: input.environmentId, input: payload },
            { reportFailure: false, reportDefect: false },
          );
          if (result._tag === "Success") return result.value.text;
          throwIfVoiceTranscriptionAborted(transcribeSignal);
          const failure = squashAtomCommandFailure(result);
          throw new VoiceTranscriptionError(
            "transcription-failed",
            "Environment transcription failed.",
            { cause: failure, userMessage: personalVoiceFailureMessage(failure) },
          );
        },
      };
    },
  };
}
