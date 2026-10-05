import { RegistryContext } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { createEnvironmentVoiceTranscriber } from "@t3tools/client-runtime/personal/voice";
import {
  VOICE_RECORDING_LIMIT_SECONDS,
  VoiceInputController,
  type VoiceDraftSnapshot,
  type VoiceInputState,
} from "@t3tools/client-runtime/voice-input";
import { useContext, useEffect, useRef, useState } from "react";

import { toastManager } from "../components/ui/toast";
import { personalVoiceEnvironment } from "./personalVoice";
import { WebVoiceRecorder } from "./webVoiceRecorder";

export interface ComposerDictationDraft {
  readonly ownerKey: string;
  readonly readSnapshot: () => { readonly value: string; readonly expandedCursor: number };
  /** Replaces `[start, end)` when it still holds `expectedText`; false when the draft moved on. */
  readonly applyReplacement: (
    start: number,
    end: number,
    replacement: string,
    options: { readonly expectedText: string; readonly expandedCursorAfterReplace: number },
  ) => boolean;
}

const IDLE_STATE: VoiceInputState = { phase: "idle", error: null, errorAction: null };

/** The single range whose replacement turns `before` into `after`. */
function changedRange(before: string, after: string) {
  let prefix = 0;
  const shortest = Math.min(before.length, after.length);
  while (prefix < shortest && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < shortest - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return {
    start: prefix,
    end: before.length - suffix,
    replacement: after.slice(prefix, after.length - suffix),
  };
}

/**
 * Drives composer dictation with the shared voice-input controller, which owns the
 * draft-revision guard: a transcript that arrives after the draft was edited is dropped
 * with an explanation instead of overwriting the edit.
 */
export function useComposerDictation(input: {
  readonly environmentId: EnvironmentId;
  readonly enabled: boolean;
  readonly draft: ComposerDictationDraft;
}) {
  const registry = useContext(RegistryContext);
  const latest = useRef(input);
  latest.current = input;
  const [state, setState] = useState<VoiceInputState>(IDLE_STATE);
  const [elapsedMs, setElapsedMs] = useState(0);
  const revision = useRef({ text: "", value: 0 });

  const controllerRef = useRef<VoiceInputController | null>(null);
  if (controllerRef.current === null) {
    const recorder = new WebVoiceRecorder();
    const controller = new VoiceInputController({
      recorder,
      getTranscriber: () =>
        latest.current.enabled
          ? createEnvironmentVoiceTranscriber({
              registry,
              atoms: personalVoiceEnvironment,
              environmentId: latest.current.environmentId,
              locale: navigator.language,
              readRecording: (uri) => recorder.readRecording(uri),
            })
          : null,
      requestPermission: () => recorder.requestPermission(),
      configureRecording: async () => undefined,
      releaseRecording: () => recorder.release(),
      deleteRecording: (uri) => recorder.deleteRecording(uri),
      readDraft: (): VoiceDraftSnapshot => {
        const { draft } = latest.current;
        const snapshot = draft.readSnapshot();
        if (snapshot.value !== revision.current.text) {
          revision.current = { text: snapshot.value, value: revision.current.value + 1 };
        }
        return {
          ownerKey: draft.ownerKey,
          text: snapshot.value,
          selection: { start: snapshot.expandedCursor, end: snapshot.expandedCursor },
          revision: revision.current.value,
        };
      },
      commitDraft: (text, selection) => {
        const { draft } = latest.current;
        const current = draft.readSnapshot().value;
        const range = changedRange(current, text);
        const applied = draft.applyReplacement(range.start, range.end, range.replacement, {
          expectedText: current.slice(range.start, range.end),
          expandedCursorAfterReplace: selection.start,
        });
        if (!applied) {
          toastManager.add({
            type: "error",
            title: "Dictation was not inserted",
            description: "The draft could not accept the transcript.",
          });
        }
      },
      onStateChange: setState,
    });
    recorder.onLimitReached = () => {
      void controller.handleRecorderStatus({
        isFinished: true,
        hasError: false,
        error: null,
        url: recorder.uri,
      });
    };
    controllerRef.current = controller;
  }
  const controller = controllerRef.current;

  useEffect(() => () => controller.dispose(), [controller]);

  const ownerKey = input.draft.ownerKey;
  useEffect(() => {
    controller.ownerChanged();
  }, [controller, ownerKey]);

  useEffect(() => {
    if (state.phase !== "recording") return;
    const startedAt = Date.now();
    const timer = window.setInterval(() => setElapsedMs(Date.now() - startedAt), 500);
    return () => {
      window.clearInterval(timer);
      setElapsedMs(0);
    };
  }, [state.phase]);

  useEffect(() => {
    if (state.phase !== "error" || !state.error) return;
    toastManager.add({
      type: "error",
      title: "Dictation failed",
      description:
        state.errorAction === "settings"
          ? `${state.error} Allow microphone access for this site in your browser settings.`
          : state.error,
    });
    controller.cancel();
  }, [controller, state]);

  return {
    state,
    elapsedMs,
    limitSeconds: VOICE_RECORDING_LIMIT_SECONDS,
    start: () => void controller.start(),
    stop: () => void controller.stop(),
    cancel: () => controller.cancel(),
  };
}
