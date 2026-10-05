/**
 * Pure helpers for the organizer: name normalization, deterministic rules,
 * the classification prompt, and validation of model output. No I/O here so
 * the rules stay testable without a database or a model.
 */
import { PERSONAL_GROUP_NAME_MAX_LENGTH } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const ROUTINES_WORKSTREAM = "Routines";
export const FIRST_MESSAGE_MAX_CHARS = 400;

const SMALL_WORDS = new Set([
  "a",
  "an",
  "and",
  "as",
  "at",
  "but",
  "by",
  "for",
  "in",
  "of",
  "on",
  "or",
  "the",
  "to",
  "vs",
  "via",
  "with",
]);
const PATH_SEPARATOR = /[/\\>›»|]/;

/**
 * Canonical group name: trimmed, single-spaced, Title Case (acronyms and
 * mixed-case words such as "iOS" or "T3" are kept), at most 40 characters cut
 * at a word boundary. Returns null for names that cannot be a group name,
 * including anything that looks like a path ("A / B").
 */
export function normalizeGroupName(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw
    .replace(/\s/g, " ")
    .replace(/^[\s"'`*#\-–—:.]+|[\s"'`*.:,;]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length === 0 || PATH_SEPARATOR.test(cleaned)) return null;
  const words = cleaned.split(" ").map((word, index) => {
    if (/[A-Z0-9]/.test(word.slice(1)) || /^[A-Z]/.test(word)) return word;
    const lower = word.toLowerCase();
    if (index > 0 && SMALL_WORDS.has(lower)) return lower;
    return lower.charAt(0).toUpperCase() + lower.slice(1);
  });
  let name = words.join(" ");
  if (name.length > PERSONAL_GROUP_NAME_MAX_LENGTH) {
    const cut = name.slice(0, PERSONAL_GROUP_NAME_MAX_LENGTH + 1);
    const lastSpace = cut.lastIndexOf(" ");
    name = (lastSpace > 10 ? cut.slice(0, lastSpace) : cut.slice(0, PERSONAL_GROUP_NAME_MAX_LENGTH))
      .replace(/[\s,;:.\-–—]+$/, "")
      .trim();
  }
  return name.length > 0 ? name : null;
}

export const sameGroupName = (left: string, right: string) =>
  left.localeCompare(right, undefined, { sensitivity: "accent" }) === 0;

export interface GroupTreeEntry {
  readonly workstream: string;
  readonly projects: ReadonlyArray<string>;
}

/** What the organizer knows about one unplaced thread. */
export interface OrganizerThreadInput {
  readonly threadId: string;
  readonly projectId: string;
  readonly title: string;
  readonly provider: string;
  readonly origin: string | null;
  readonly originDetail: string | null;
  readonly firstUserMessage: string | null;
  /** Parent thread for subagents/forks, or a synced external parent session. */
  readonly parentThreadId: string | null;
}

export interface PlacementPath {
  readonly workstream: string;
  readonly project: string | null;
  readonly reason: string;
}

export type DeterministicDecision =
  | { readonly type: "follow-parent"; readonly parentThreadId: string }
  | { readonly type: "wait-for-parent" }
  | { readonly type: "path"; readonly path: PlacementPath }
  | { readonly type: "none" };

/**
 * Rules that need no model. Children go where their parent went (and wait
 * while the parent itself is still unclassified); Hermes cron runs land in
 * Routines / <job name>.
 */
export function decideDeterministic(
  thread: OrganizerThreadInput,
  parentState: (threadId: string) => "placed" | "pending" | "missing",
): DeterministicDecision {
  if (thread.parentThreadId !== null) {
    const state = parentState(thread.parentThreadId);
    if (state === "placed") return { type: "follow-parent", parentThreadId: thread.parentThreadId };
    if (state === "pending") return { type: "wait-for-parent" };
  }
  if (thread.origin === "cron") {
    return {
      type: "path",
      path: {
        workstream: ROUTINES_WORKSTREAM,
        project: normalizeGroupName(thread.originDetail),
        reason: "Scheduled Hermes routine",
      },
    };
  }
  return { type: "none" };
}

export function truncateForPrompt(text: string | null, max = FIRST_MESSAGE_MAX_CHARS): string {
  if (text === null) return "";
  const single = text.replace(/\s+/g, " ").trim();
  return single.length <= max ? single : `${single.slice(0, max - 1)}…`;
}

export const ClassificationOutput = Schema.Struct({
  placements: Schema.Array(
    Schema.Struct({
      threadId: Schema.String,
      workstream: Schema.String,
      project: Schema.NullOr(Schema.String),
      reason: Schema.String,
    }),
  ),
});
export type ClassificationOutput = typeof ClassificationOutput.Type;
const decodeClassificationOutput = Schema.decodeUnknownOption(ClassificationOutput);

export function buildClassificationPrompt(input: {
  readonly repoName: string;
  readonly tree: ReadonlyArray<GroupTreeEntry>;
  readonly threads: ReadonlyArray<OrganizerThreadInput>;
}): string {
  const tree =
    input.tree.length === 0
      ? "(none yet)"
      : input.tree
          .map((entry) =>
            [`- ${entry.workstream}`, ...entry.projects.map((project) => `  - ${project}`)].join(
              "\n",
            ),
          )
          .join("\n");
  const threads = input.threads
    .map((thread) =>
      [
        `threadId: ${thread.threadId}`,
        `title: ${truncateForPrompt(thread.title, 120)}`,
        `provider: ${thread.provider}`,
        ...(thread.origin ? [`origin: ${thread.origin}`] : []),
        `first user message: ${truncateForPrompt(thread.firstUserMessage) || "(empty)"}`,
      ].join("\n"),
    )
    .join("\n\n");
  return [
    "You sort a person's agent conversations into a small, stable hierarchy inside one repository or area.",
    'Level 1 is a workstream: a broad, long-lived area of work or life (1-3 words, e.g. "Job Search", "Billing", "Health").',
    'Level 2 is an optional project: a specific effort inside that workstream (e.g. "Applications"). Use null when the thread fits the workstream broadly.',
    "Strongly prefer the existing groups below. Invent a new group only when nothing existing fits; never create near-duplicates of existing names.",
    "Names are plain labels: no slashes, arrows, or nesting deeper than workstream > project.",
    "Return one entry per thread, copying threadId exactly. reason is at most 12 words.",
    "",
    `Repository: ${input.repoName}`,
    "Existing groups:",
    tree,
    "",
    "Threads:",
    threads,
  ].join("\n");
}

export interface ValidatedPlacement extends PlacementPath {
  readonly threadId: string;
}

/**
 * Keep only well-formed answers for threads we asked about. Names are
 * normalized and snapped to existing groups (case-insensitive). New groups
 * beyond `maxNewGroups` are refused: a new project falls back to its
 * workstream, a new workstream drops the answer.
 */
export function validateClassification(input: {
  readonly output: unknown;
  readonly threadIds: ReadonlySet<string>;
  readonly tree: ReadonlyArray<GroupTreeEntry>;
  readonly maxNewGroups: number;
}): ReadonlyArray<ValidatedPlacement> {
  const decoded = decodeClassificationOutput(input.output);
  if (decoded._tag === "None") return [];
  const known = input.tree.map((entry) => ({
    workstream: entry.workstream,
    projects: [...entry.projects],
  }));
  let newGroups = 0;
  const seen = new Set<string>();
  const result: ValidatedPlacement[] = [];
  for (const answer of decoded.value.placements) {
    if (!input.threadIds.has(answer.threadId) || seen.has(answer.threadId)) continue;
    const workstreamName = normalizeGroupName(answer.workstream);
    if (workstreamName === null) continue;
    const rawProject = answer.project?.trim() ?? "";
    let projectName = rawProject.length === 0 ? null : normalizeGroupName(rawProject);
    if (rawProject.length > 0 && projectName === null) continue;

    let workstream = known.find((entry) => sameGroupName(entry.workstream, workstreamName));
    if (workstream === undefined) {
      if (newGroups >= input.maxNewGroups) continue;
      newGroups += 1;
      workstream = { workstream: workstreamName, projects: [] };
      known.push(workstream);
    }
    if (projectName !== null) {
      const existing = workstream.projects.find((project) => sameGroupName(project, projectName!));
      if (existing !== undefined) {
        projectName = existing;
      } else if (sameGroupName(projectName, workstream.workstream)) {
        projectName = null;
      } else if (newGroups >= input.maxNewGroups) {
        projectName = null;
      } else {
        newGroups += 1;
        workstream.projects.push(projectName);
      }
    }
    seen.add(answer.threadId);
    result.push({
      threadId: answer.threadId,
      workstream: workstream.workstream,
      project: projectName,
      reason: truncateForPrompt(answer.reason, 160) || "Organizer classification",
    });
  }
  return result;
}
