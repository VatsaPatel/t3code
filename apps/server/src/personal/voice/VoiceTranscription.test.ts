// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../../config.ts";
import * as ProcessRunner from "../../processRunner.ts";
import * as VoiceTranscription from "./VoiceTranscription.ts";

const testLayer = VoiceTranscription.layer.pipe(
  Layer.provideMerge(ProcessRunner.layer),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-voice-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const AUDIO_BASE64 = Buffer.from("not-really-audio").toString("base64");
const SECRET = "SUPER-SECRET-VALUE-123";

/** Writes a fake engine plus its settings file; returns paths the script reports back through. */
const installFakeEngine = (script: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig.ServerConfig;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-voice-engine-" });
    const scriptPath = NodePath.join(root, "engine.sh");
    const envPath = NodePath.join(root, "engine.env");
    // The script parses --input/--output like the Hermes adapter and records the temp
    // directory it was given in $MARKER_DIR/workdir.
    yield* fileSystem.writeFileString(
      scriptPath,
      `#!/bin/sh
ROOT="$(dirname "$0")"
while [ $# -gt 0 ]; do
  case "$1" in
    --input) INPUT="$2"; shift 2;;
    --output) OUTPUT="$2"; shift 2;;
    --language) LANGUAGE="$2"; shift 2;;
    *) shift;;
  esac
done
dirname "$INPUT" > "$ROOT/workdir"
${script}
`,
    );
    NodeFS.chmodSync(scriptPath, 0o755);
    yield* fileSystem.writeFileString(
      envPath,
      `# comment\nVOICE_TEST_SECRET=${SECRET}\nVOICE_TEST_WORD='hello'\n`,
    );
    yield* fileSystem.writeFileString(
      NodePath.join(config.stateDir, "personal-voice-settings.json"),
      toJson({
        command: scriptPath,
        args: ["--input", "{input}", "--output", "{output}", "--language", "{language}"],
        envFile: envPath,
        timeoutMs: 1000,
      }),
    );
    return {
      root,
      workdir: () => NodeFS.readFileSync(NodePath.join(root, "workdir"), "utf8").trim(),
    };
  });

it.live("returns the engine transcript, passes the env file, and removes temp files", () =>
  Effect.gen(function* () {
    const engine = yield* installFakeEngine(
      `test -s "$INPUT" && echo "$VOICE_TEST_WORD $LANGUAGE" > "$OUTPUT"`,
    );
    const voice = yield* VoiceTranscription.VoiceTranscription;

    assert.equal((yield* voice.status).configured, true);
    const result = yield* voice.transcribe({
      audioBase64: AUDIO_BASE64,
      mimeType: "audio/webm;codecs=opus",
      language: "en-US",
    });

    assert.equal(result.text, "hello en-US");
    assert.equal(NodeFS.existsSync(engine.workdir()), false);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.live("maps a failing engine to a redacted engine error and removes temp files", () =>
  Effect.gen(function* () {
    const engine = yield* installFakeEngine(
      `echo "request failed for key $VOICE_TEST_SECRET" >&2; exit 3`,
    );
    const voice = yield* VoiceTranscription.VoiceTranscription;

    const failure = yield* voice
      .transcribe({ audioBase64: AUDIO_BASE64, mimeType: "audio/webm" })
      .pipe(Effect.flip);

    assert.equal(failure._tag, "PersonalVoiceEngineError");
    if (failure._tag === "PersonalVoiceEngineError") {
      assert.equal(failure.exitCode, 3);
      assert.include(failure.detail, "request failed");
      assert.notInclude(failure.detail, SECRET);
    }
    assert.equal(NodeFS.existsSync(engine.workdir()), false);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.live("reports empty transcripts and timeouts distinctly", () =>
  Effect.gen(function* () {
    yield* installFakeEngine(`: > "$OUTPUT"`);
    const voice = yield* VoiceTranscription.VoiceTranscription;
    const empty = yield* voice
      .transcribe({ audioBase64: AUDIO_BASE64, mimeType: "audio/webm" })
      .pipe(Effect.flip);
    assert.equal(empty._tag, "PersonalVoiceEmptyTranscriptError");

    const slow = yield* installFakeEngine(`sleep 30`);
    const timedOut = yield* voice
      .transcribe({ audioBase64: AUDIO_BASE64, mimeType: "audio/webm" })
      .pipe(Effect.flip);
    assert.equal(timedOut._tag, "PersonalVoiceTimeoutError");
    assert.equal(NodeFS.existsSync(slow.workdir()), false);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.live("kills the engine process and cleans up when the transcription is cancelled", () =>
  Effect.gen(function* () {
    const engine = yield* installFakeEngine(`echo $$ > "$ROOT/pid"; exec sleep 30`);
    const voice = yield* VoiceTranscription.VoiceTranscription;
    const pidPath = NodePath.join(engine.root, "pid");

    const fiber = yield* voice
      .transcribe({ audioBase64: AUDIO_BASE64, mimeType: "audio/webm" })
      .pipe(Effect.forkChild);
    // The child is external, so wait for the pid it records before cancelling.
    while (!NodeFS.existsSync(pidPath) || NodeFS.readFileSync(pidPath, "utf8").trim() === "") {
      yield* Effect.sleep("20 millis");
    }
    const pid = Number(NodeFS.readFileSync(pidPath, "utf8").trim());
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    assert.equal(alive(), true);

    yield* Fiber.interrupt(fiber);
    for (let attempt = 0; attempt < 50 && alive(); attempt += 1) {
      yield* Effect.sleep("20 millis");
    }
    assert.equal(alive(), false);
    assert.equal(NodeFS.existsSync(engine.workdir()), false);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.live("is not configured when the engine command is missing", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig.ServerConfig;
    yield* fileSystem.writeFileString(
      NodePath.join(config.stateDir, "personal-voice-settings.json"),
      toJson({ command: "/nonexistent/t3-voice-engine", envFile: null }),
    );
    const voice = yield* VoiceTranscription.VoiceTranscription;

    const status = yield* voice.status;
    assert.equal(status.configured, false);
    const failure = yield* voice
      .transcribe({ audioBase64: AUDIO_BASE64, mimeType: "audio/webm" })
      .pipe(Effect.flip);
    assert.equal(failure._tag, "PersonalVoiceNotConfiguredError");
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);
