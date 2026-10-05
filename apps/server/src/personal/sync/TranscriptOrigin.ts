/**
 * TranscriptOrigin - classify a Codex or Claude transcript from its first
 * records without parsing the whole file.
 *
 * Codex writes a `session_meta` record first with the originating client and
 * session source; Claude stamps every record with an `entrypoint`. Those tell
 * apart interactive sessions worth mirroring from T3 Code's own sessions,
 * scripted one-shot runs, and Codex subagents (which belong under a parent).
 *
 * @module personal/sync/TranscriptOrigin
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

/** Codex `session_meta` lines carry the full base instructions; this covers them. */
const MAX_HEADER_BYTES = 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;

interface TranscriptOrigin {
  /** False for T3 Code's own sessions and non-interactive runs (`codex exec`, `claude -p`). */
  readonly interactive: boolean;
  /** Codex subagent parent thread id, when the session was spawned by another one. */
  readonly parentSessionId: string | null;
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

function classifyCodexSessionMeta(line: string): TranscriptOrigin {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { interactive: true, parentSessionId: null };
  }
  const payload = asRecord(asRecord(parsed)?.payload);
  const originator = payload?.originator;
  const source = payload?.source;
  const spawn = asRecord(asRecord(asRecord(source)?.subagent)?.thread_spawn);
  const parent = spawn?.parent_thread_id;
  return {
    interactive: originator !== "T3 Code" && source !== "exec" && source !== "mcp",
    parentSessionId: typeof parent === "string" && parent.trim() !== "" ? parent : null,
  };
}

function classifyClaudeRecords(lines: ReadonlyArray<string>): TranscriptOrigin {
  for (const line of lines) {
    const match = /"entrypoint"\s*:\s*"([^"]*)"/.exec(line);
    if (match === null) continue;
    // `sdk-cli` is `claude -p`: scripted one-shot runs, including T3's own
    // commit-message generation.
    return { interactive: match[1] !== "sdk-cli", parentSessionId: null };
  }
  return { interactive: true, parentSessionId: null };
}

/** Read the first records of a transcript. Unreadable files classify as interactive. */
export const readTranscriptOrigin = Effect.fn("TranscriptOrigin.read")(function* (
  filePath: string,
  source: "codex" | "claudeAgent",
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const head = yield* Effect.scoped(
    fileSystem.open(filePath, { flag: "r" }).pipe(
      Effect.flatMap((file) =>
        Effect.gen(function* () {
          const decoder = new TextDecoder();
          let text = "";
          while (text.length < MAX_HEADER_BYTES) {
            const chunk = yield* file.readAlloc(CHUNK_BYTES);
            if (Option.isNone(chunk) || chunk.value.byteLength === 0) break;
            text += decoder.decode(chunk.value, { stream: true });
            // Codex needs only its first record; Claude's entrypoint shows up
            // on the first message records.
            if (source === "codex" ? text.includes("\n") : text.split("\n").length > 8) break;
          }
          return text;
        }),
      ),
    ),
  ).pipe(Effect.orElseSucceed(() => ""));
  const lines = head.split("\n");
  return source === "codex"
    ? classifyCodexSessionMeta(lines[0] ?? "")
    : classifyClaudeRecords(lines.slice(0, 8));
});
