# Personal overlay (Vatsa's fork)

This branch (`personal/main`) is upstream T3 Code plus a small overlay that makes T3 the place
where Vatsa runs his _day_ across agents, not just one coding chat. v1 (tag
`archive/personal-workspace-v1`) tried to rebuild the sidebar, organizer, provider and voice
stack inside upstream files; it touched ~60 upstream files and upstream has since shipped much of
it (session import, voice input, rich copy, scheduled tasks, ACP local commands). v2 keeps only
what upstream does not do and what changes a decision Vatsa makes every day.

## Reasoning per feature (written before building)

The test for each feature: _who reads it, what decision does it enable, what curates it, what does
it cost, and can it lie?_

### 1. Waiting on you (Home) — KEEP, LLM-curated

- **Reader / decision:** Vatsa, several times a day: "which agent conversation is blocked on me,
  and what exactly does it need?" Today that answer is scattered across Slack DMs with Hermes,
  WhatsApp, Hermes CLI/desktop, Codex CLI and Claude Code terminals.
- **Source:** read-only `~/.hermes/state.db` (sessions + last messages, excluding `subagent` and
  `cron` noise), `~/.codex/state_5.sqlite` threads, `~/.claude/projects/*/*.jsonl` tails. T3's own
  threads already show approvals/questions in the upstream sidebar, so they are not duplicated.
- **Curator:** a background loop asks a cheap model (`google/gemini-3.8-flash` via OpenRouter, ZDR)
  one question per conversation whose last turn is the agent's: _does this end by asking the user
  for a decision, input or action? If so, state the ask in ≤ 15 words._ Result cached by
  `(session, last message id)`, so a conversation is classified once per new agent turn.
- **Bounds:** only conversations active in the last 7 days, ≤ 25 classifications per 5-minute
  tick, transcript tail ≤ 4 KB. Steady state is a few cents a day.
- **Honest state:** a row disappears only when the conversation gets a newer user turn or Vatsa
  dismisses it (dismiss is reversible from "Dismissed"). Unclassified rows say "checking"; an
  unavailable source says so instead of looking empty. Rows waiting > 48h are marked stale.
- **Action:** each row shows where it lives (Slack, WhatsApp, CLI, Codex, Claude) and a copyable
  resume command (`hermes --resume <id>`, `codex resume <id>`, `claude --resume <id>`).

### 2. Daily digest of agent activity (Home) — KEEP, LLM-curated

- **Reader / decision:** "what did my agents actually get done since yesterday, and did anything
  fail?" Hermes runs ~1,000 cron and ~1,000 subagent sessions a month; nobody reads them.
- **Curator:** once per day (and on demand via Refresh), collect titles + last assistant message
  of every non-subagent session from the last 24h across Hermes, Codex and Claude, plus cron
  failures, and ask the model for ≤ 8 bullets grouped _Done / Failed / Still open_. Stored with its
  generation time and source counts so it is never presented as fresher than it is.
- **Bounds:** one call/day, input capped at ~30 KB.

### 3. Today: Slack to-dos (Home) — KEEP, deterministic

- **Reader / decision:** "what do I owe today?" To-dos now live in Slack native To-dos (Hermes
  crons write there). T3 is an interface, not a second store.
- **Source:** `python3 ~/repos/personal-git/todo/slack_todo.py list|add|done`. Overdue + due
  today + next 3 days shown; "someday" hidden behind a count. Complete is a real write and is
  verified by re-listing. No LLM: the list is already curated by Hermes.

### 4. Morning brief (Home) — KEEP, deterministic

The newest output of the Hermes brief cron (`Daily life chief-of-staff brief`, else
`Daily plan (morning)`) rendered as markdown, collapsed to its first section, with its timestamp.

### 5. Routines — KEEP, deterministic + light curation

- **Reader / decision:** "are my automations healthy, and when does each run next?" Lists Hermes
  cron jobs from `~/.hermes/cron/jobs.json` sorted by next run, with status (ok / failed /
  paused / completed), last output preview, and Run now / Pause / Resume through the `hermes cron`
  CLI (the CLI owns locking and the scheduler; we never write `jobs.json`).
- T3 scheduled tasks are already a first-class upstream page (Settings → Scheduled tasks); not
  duplicated.

### 6. Hermes as a T3 provider — KEEP, zero code

Upstream now supports **Local ACP command** providers and Hermes ships `hermes acp`. That gives
Hermes chats inside T3 (approvals, models, streaming) without any fork code. Documented in
[MERGING.md](./MERGING.md#hermes-provider). v1's custom gateway provider (~1,500 lines) is cut.

### Cut, and why

| v1 feature                                 | Decision                                                                                                     |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| Codex/Claude session sync into T3 threads  | Upstream ships `agentSessions.scan/import` (Welcome → import). Cut.                                          |
| Organizer tree repo → workstream → project | Highest-conflict surface (upstream sidebar churns daily) and moving labels did not change any decision. Cut. |
| Dictation                                  | Upstream voice input. Cut.                                                                                   |
| Copy rich                                  | Upstream `markdown-clipboard`. Cut.                                                                          |
| ⌘K group scope                             | Depended on the organizer. Cut.                                                                              |
| Native fork of synced sessions             | Copy-resume command covers the real need at zero risk. Cut.                                                  |
| Auto-titling                               | Hermes and Claude already title sessions; Codex uses first message. Cut.                                     |

## Architecture (mergeability first)

- Server: `apps/server/src/personal/` — plain service + one HTTP router layer under
  `/api/personal/*`, authenticated with the same `EnvironmentAuth` as every other route. Remote and
  tunnel clients work because it is just an authenticated same-origin route.
- State: a **separate** SQLite file `<stateDir>/personal.sqlite` (curation cache, dismissals,
  digest). Never touches upstream's migration table.
- Web: `apps/web/src/personal/` + two route files (`_chat.home.tsx`, `_chat.routines.tsx`).
- Upstream edits: registration lines only. See [MERGING.md](./MERGING.md).
- Mobile: not supported (personal web/desktop only); the API is plain JSON so it can follow.
