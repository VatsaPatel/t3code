import type { VoiceRecorder } from "@t3tools/client-runtime/voice-input";
import type { RecordedAudio } from "@t3tools/client-runtime/personal/voice";

// First supported type wins. Chromium and Firefox record webm/ogg opus; Safari records mp4.
const PREFERRED_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/mp4",
] as const;

export function isVoiceRecordingSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function" &&
    typeof MediaRecorder !== "undefined"
  );
}

function pickMimeType(): string | undefined {
  return PREFERRED_MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("error", () =>
      reject(reader.error ?? new Error("Could not read the recording.")),
    );
    reader.addEventListener("load", () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      resolve(result.slice(result.indexOf(",") + 1));
    });
    reader.readAsDataURL(blob);
  });
}

async function microphoneBlockedByUser(): Promise<boolean> {
  try {
    const status = await navigator.permissions?.query({ name: "microphone" as PermissionName });
    return status?.state === "denied";
  } catch {
    return false;
  }
}

/**
 * Records the microphone with `MediaRecorder` for the shared voice-input controller. The
 * recording lives in memory; its `blob:` URL is the controller's `uri` and is revoked on delete.
 */
export class WebVoiceRecorder implements VoiceRecorder {
  uri: string | null = null;

  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private blob: Blob | null = null;
  private startedAt = 0;
  private durationMs = 0;
  private limitTimer: ReturnType<typeof setTimeout> | null = null;
  private stopping: Promise<void> | null = null;

  /** Fires when the recording limit stops the recorder, so the controller can finish it. */
  onLimitReached: (() => void) | null = null;

  async requestPermission(): Promise<{ granted: boolean; canAskAgain: boolean }> {
    try {
      this.stream ??= await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      return { granted: true, canAskAgain: true };
    } catch (error) {
      const name = error instanceof DOMException ? error.name : "";
      if (name === "NotAllowedError" || name === "SecurityError") {
        return { granted: false, canAskAgain: !(await microphoneBlockedByUser()) };
      }
      throw error;
    }
  }

  async prepareToRecordAsync(): Promise<void> {
    if (!this.stream) throw new Error("The microphone is not available.");
    const mimeType = pickMimeType();
    this.chunks = [];
    this.blob = null;
    this.stopping = null;
    this.recorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined);
    this.recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) this.chunks.push(event.data);
    });
  }

  record({ forDuration }: { readonly forDuration: number }): void {
    const recorder = this.recorder;
    if (!recorder) throw new Error("The recorder is not prepared.");
    this.startedAt = Date.now();
    recorder.start();
    this.limitTimer = setTimeout(() => {
      void this.stop().then(() => this.onLimitReached?.());
    }, forDuration * 1000);
  }

  /** Idempotent: a manual stop racing the limit timer shares one flush. */
  stop(): Promise<void> {
    this.stopping ??= this.finishRecorder();
    return this.stopping;
  }

  private async finishRecorder(): Promise<void> {
    if (this.limitTimer) clearTimeout(this.limitTimer);
    this.limitTimer = null;
    const recorder = this.recorder;
    if (!recorder || recorder.state === "inactive") return;
    await new Promise<void>((resolve) => {
      recorder.addEventListener("stop", () => resolve(), { once: true });
      recorder.stop();
    });
    this.durationMs = Date.now() - this.startedAt;
    this.blob = new Blob(this.chunks, { type: recorder.mimeType || "audio/webm" });
    this.uri = this.blob.size > 0 ? URL.createObjectURL(this.blob) : null;
  }

  /** Releases the microphone so the browser's recording indicator turns off. */
  release(): Promise<void> {
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    this.recorder = null;
    this.stopping = null;
    return Promise.resolve();
  }

  deleteRecording(uri: string): void {
    URL.revokeObjectURL(uri);
    if (this.uri === uri) {
      this.uri = null;
      this.blob = null;
      this.chunks = [];
    }
  }

  async readRecording(uri: string): Promise<RecordedAudio> {
    if (!this.blob || this.uri !== uri) throw new Error("The recording is no longer available.");
    return {
      base64: await blobToBase64(this.blob),
      mimeType: this.blob.type,
      durationMs: this.durationMs,
    };
  }
}
