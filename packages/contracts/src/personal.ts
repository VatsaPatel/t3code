// Personal overlay wire types (fork-only). Plain JSON over `/api/personal/*`.
// Kept dependency-free so upstream contract churn never conflicts with it.

export type PersonalSourceKind = "hermes" | "codex" | "claude";

export interface PersonalSourceStatus {
  readonly kind: PersonalSourceKind;
  readonly available: boolean;
  readonly detail: string | null;
}

export interface PersonalWaitingItem {
  readonly key: string;
  readonly source: PersonalSourceKind;
  /** Where the conversation lives, e.g. "Slack", "WhatsApp", "CLI", "Codex", "Claude Code". */
  readonly origin: string;
  readonly sessionId: string;
  readonly title: string;
  readonly cwd: string | null;
  /** LLM-curated one-line ask; null while not yet classified. */
  readonly ask: string | null;
  readonly lastAgentText: string;
  readonly lastAgentAt: string;
  readonly stale: boolean;
  readonly resumeCommand: string;
  readonly dismissed: boolean;
}

export interface PersonalWaitingResult {
  readonly items: ReadonlyArray<PersonalWaitingItem>;
  readonly pendingClassification: number;
  readonly sources: ReadonlyArray<PersonalSourceStatus>;
  readonly curatorAvailable: boolean;
  readonly curatedAt: string | null;
}

export interface PersonalDigest {
  readonly markdown: string;
  readonly generatedAt: string;
  readonly windowHours: number;
  readonly sessionCount: number;
  readonly model: string;
}

export interface PersonalDigestResult {
  readonly digest: PersonalDigest | null;
  readonly curatorAvailable: boolean;
  readonly generating: boolean;
  readonly error: string | null;
}

export interface PersonalTodo {
  readonly id: string;
  readonly priority: number;
  readonly due: string | null;
  readonly project: string;
  readonly text: string;
}

export interface PersonalTodosResult {
  readonly available: boolean;
  readonly error: string | null;
  readonly todos: ReadonlyArray<PersonalTodo>;
}

export interface PersonalBrief {
  readonly jobName: string;
  readonly ranAt: string;
  readonly markdown: string;
}

export interface PersonalRoutine {
  readonly id: string;
  readonly name: string;
  readonly schedule: string;
  readonly enabled: boolean;
  readonly state: string;
  readonly nextRunAt: string | null;
  readonly lastRunAt: string | null;
  readonly lastStatus: string | null;
  readonly lastError: string | null;
  readonly lastOutputPreview: string | null;
  readonly deliver: string | null;
}

export interface PersonalRoutinesResult {
  readonly available: boolean;
  readonly error: string | null;
  readonly routines: ReadonlyArray<PersonalRoutine>;
}

export type PersonalRoutineAction = "run" | "pause" | "resume";
