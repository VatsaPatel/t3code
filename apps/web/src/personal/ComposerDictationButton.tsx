import type { EnvironmentId } from "@t3tools/contracts";
import { CheckIcon, MicIcon, XIcon } from "lucide-react";

import { Button } from "../components/ui/button";
import { Spinner } from "../components/ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { useEnvironmentQuery } from "../state/query";
import { personalVoiceEnvironment } from "./personalVoice";
import { type ComposerDictationDraft, useComposerDictation } from "./useComposerDictation";
import { isVoiceRecordingSupported } from "./webVoiceRecorder";

function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * Composer microphone: records, has the environment transcribe, and inserts the text at the
 * cursor. Nothing is sent. Hidden when the environment has no speech engine or the browser
 * cannot record.
 */
export function ComposerDictationButton(props: {
  readonly environmentId: EnvironmentId;
  readonly draft: ComposerDictationDraft;
}) {
  const status = useEnvironmentQuery(
    personalVoiceEnvironment.status({ environmentId: props.environmentId, input: {} }),
  );
  const available = status.data?.configured === true && isVoiceRecordingSupported();
  const dictation = useComposerDictation({
    environmentId: props.environmentId,
    enabled: available,
    draft: props.draft,
  });
  const { phase } = dictation.state;

  if (!available && phase === "idle") return null;

  if (phase === "recording") {
    return (
      <div className="flex items-center gap-0.5">
        <span className="me-1 flex items-center gap-1.5 text-xs tabular-nums text-muted-foreground">
          <span className="size-2 rounded-full bg-destructive" aria-hidden="true" />
          {formatElapsed(dictation.elapsedMs)}
        </span>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onPointerDown={(event) => event.preventDefault()}
                onClick={dictation.stop}
                aria-label="Stop and transcribe"
              />
            }
          >
            <CheckIcon />
          </TooltipTrigger>
          <TooltipPopup>Stop and transcribe</TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onPointerDown={(event) => event.preventDefault()}
                onClick={dictation.cancel}
                aria-label="Cancel recording"
              />
            }
          >
            <XIcon />
          </TooltipTrigger>
          <TooltipPopup>Cancel recording</TooltipPopup>
        </Tooltip>
      </div>
    );
  }

  const busy = phase === "preparing" || phase === "transcribing";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={phase === "preparing"}
            onPointerDown={(event) => event.preventDefault()}
            onClick={busy ? dictation.cancel : dictation.start}
            aria-label={phase === "transcribing" ? "Cancel transcription" : "Dictate"}
          />
        }
      >
        {busy ? <Spinner /> : <MicIcon />}
      </TooltipTrigger>
      <TooltipPopup>
        {phase === "transcribing" ? "Transcribing… click to cancel" : "Dictate"}
      </TooltipPopup>
    </Tooltip>
  );
}
