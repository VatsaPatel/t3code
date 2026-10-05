# Voice input

Transcription edits a composer draft. It does not submit an agent turn. Audio is
temporary client input, and only normal message submission sends the resulting
text. Mobile transcribes locally on supported iOS devices. Web and desktop send the
recording to the environment (`personal.voice.transcribe`), which runs a configurable
speech-to-text command; see [`createEnvironmentVoiceTranscriber`](../../packages/client-runtime/src/personal/voice.ts)
and the [server service](../../apps/server/src/personal/voice/VoiceTranscription.ts).
Cancelling interrupts the RPC, which makes the server kill the engine process.

The [shared controller](../../packages/client-runtime/src/voice-input/controller.ts)
owns the operation while the client supplies capture and transcription. Preparation
binds the transcriber and resolved locale for the whole recording. Draft ownership,
text, and revision are captured before recording and checked before insertion, so
a late transcript cannot overwrite a draft that was edited or replaced.

Cancellation invalidates a result immediately, but resources stay owned until the
underlying work settles. Apple's native transcription call cannot be interrupted
once started. Releasing the session or deleting its recording when the abort signal
fires would race that work. The [transcription contract](../../packages/client-runtime/src/voice-input/transcription.ts)
therefore requires implementations to settle only after their work has stopped;
the [Apple binding](../../apps/mobile/src/native/voiceTranscription.ios.ts) checks
cancellation between native calls and discards late results.
