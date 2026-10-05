# Personal agent workspace — design and intentions

This fork turns T3 Code into one place to run a personal agent (Hermes) and work agents (Codex,
Claude Code) side by side. T3 is already excellent inside a single chat; what it lacks is **chat
management**: hundreds of conversations that start in different places, need finding, continuing,
organizing and following up. This document records what we are building, why, and the rules that
keep it calm. The [design plan](./design-plan.md) records the tokens and reasoning. Mockups live in [`mockups/`](./mockups) and are generated as edits of real T3
screenshots, so they show the intended look rather than a new design system.

## What the user should be able to do

- See every conversation, wherever it started: T3, Codex CLI, Claude Code, and Hermes from the CLI,
  desktop app, Slack, WhatsApp, cron jobs, ACP and its subagents. New sessions appear on their own;
  conversations continued elsewhere keep updating.
- Continue any conversation in T3 using the provider's own session (native resume), and fork any
  conversation natively, so the child keeps the provider's compacted context rather than a replayed
  transcript.
- Find any conversation fast: by title, content, group, provider, origin or status.
- Keep work organized as **repo → workstream → project → chats** without manual filing: a background
  organizer files chats; the user can override, and overrides always win.
- Know at a glance what needs them (amber), what is working (green) and what failed (red).
- Run their day: to-dos (Todoist), the Hermes morning brief, Hermes routines and T3 scheduled tasks,
  and delegate a to-do to Hermes in one click.
- Dictate into any composer (MAI-Transcribe-2 through Hermes' speech setup) and copy replies with
  formatting intact.

## Principles

1. **Restraint.** If an element is not essential, leave it out. Single calm columns, generous space,
   no card grids, no wide tables, no banners, no badges everywhere. Empty sections disappear.
2. **The sidebar is the only navigator.** Pages never duplicate the tree.
3. **Status is a tiny dot, used sparingly.** Amber = needs you, green = working, red = failed.
   No counts except where something needs the user.
4. **Same T3.** Reuse T3's components, tokens, typography and icons; light and dark both work.
   Additions live in new files so upstream T3 merges stay easy (see [Maintenance](#maintenance)).
5. **Honest state.** Viewing a chat never clears "needs you". A synced chat is never shown as working
   unless a run is actually active. Unavailable sources say so.
6. **Background work stays off the interaction path.** Sync and organization run on the server on a
   bounded schedule and never block the UI.

## Information architecture

```
Sidebar
  Search (⌘K)
  Home                ← amber dot when anything needs you
  Routines
  Pinned
    Hermes            ← most recent Hermes chat, or a new one
    (T3 pinned chats)
  Workspaces          ← chevrons only, no folder or chat icons, no counts
    repo (T3 project)                  e.g. personal-git, pingdotgg/t3code
      workstream                       e.g. Job search, Health & fitness, Routines
        project                        e.g. Applications, Lead radar
          up to 3 recent chats, "More…" → group page
      unsorted chats of the repo
```

Level 1 is the T3 project (the repository; T3's logical project grouping merges checkouts across
environments). Chats with no repository live under **Personal**. Workstreams and projects are labels:
moving a chat never changes its project, working directory, provider or permissions.

## Surfaces

### Home — [mockup](./mockups/home.png)

A left-aligned daybook (see [design plan](./design-plan.md)). One bold heading, the date. A one-line
composer that asks Hermes by default (a group picker sits in its chip row). Then:

- **Waiting on you** — each row: chat title, its group in muted text, the agent's actual question on
  the second line, waiting time in tabular numerals, and Reply (opens the chat at its question panel).
  Hidden when empty.
- **The day ledger** — a 56px time gutter. Above a thin primary-blue **now** rule: what happened today
  (morning brief with Read, routine runs, agent runs that finished with Open). On the rule: a live line
  when agents are working, with Stop in its popover. Below the rule: open to-dos (Todoist) with their
  times, Add to-do (natural-language dates), and on hover Ask Hermes (delegate) and reschedule.
  Checking a to-do completes it in Todoist with undo.

### Group page — [mockup](./mockups/group.png)

Opened by clicking a workstream or project name in the sidebar (the chevron only toggles). A muted
repo crumb, the group name as heading, and quiet "New chat" and "…" (rename, new project, delete)
actions. One list ordered by priority: waiting on you, working, then most recent; each row has title,
last-message snippet, age, and an origin word ("Cron", "Slack") when it did not start in T3. Hovering
a row swaps its age for Fork and a menu (Move to…, Archive, Mark unread). Then "Projects" with chat
counts, and "Show N older chats". Shift/⌘-click selects rows and shows a small "N selected, Move,
Archive" bar. When the organizer acted, one footer line: "Hermes filed 3 chats here today." with
Review and Undo links.

### Routines — [mockup](./mockups/routines.png)

Hermes cron jobs and T3 scheduled tasks in one list, sorted by next run, using Home's time gutter,
with a quiet status word (ok, failed, missed, paused). Selecting one opens a detail panel: cadence and delivery, Run now and
Pause/Resume, the last run's rendered output, and history with links to each run's chat.

### Chat view — [mockup](./mockups/chat.png)

Unchanged transcript. Additions only: breadcrumb with the group path, Copy (rich HTML + Markdown) and
Fork on assistant messages, a microphone in the composer, and Fork thread / Move to… in the thread menu.

### ⌘K — [mockup](./mockups/palette.png)

T3's palette gains a group scope chip (`in: Job search`, Tab to scope), a Groups section, group paths
on chat results, and actions: New chat in <group>, Move current chat to…, Go to Home, Go to Routines.

## Behavior and invariants

**Attention.** Needs you = a pending approval, a pending question, or an actionable plan. It clears
only when answered, resolved or invalidated, never by viewing. Rollups count unique chats.

**Sync.** Read-only access to `~/.codex`, `~/.claude` and Hermes' `state.db`. Bounded backfill (45 days
by default), then cheap polling. A native session already bound to a T3 chat is never imported twice.
New native messages are appended only when T3 did not produce them itself (echo dedup); nothing is
appended while a T3 run is active. Hermes delegate sessions become subagent children; Hermes branches
become forks; cron runs carry their job name.

**Continue and fork.** Synced chats resume their native session. Forking uses the provider's own
fork: Codex `thread/fork`, Claude `forkSession`, Hermes `session.branch_stored`. Threads with T3 runs
use T3's existing fork command. A provider that cannot fork says so instead of silently replaying a
transcript.

**Hermes provider.** T3 drives Hermes through the same stdio JSON-RPC gateway its TUI uses, so any
Hermes session from any origin can be resumed, approvals and questions round-trip, subagents are
visible, and models switch per session without rewriting the user's Hermes config. T3 releases the
session lease when a chat goes idle, so Slack and the CLI can keep using the same conversation.

**Organizer.** Deterministic rules first (subagents and forks follow their parent; Hermes cron runs
go to Routines › job name), then the user's text-generation model for the rest, prefering existing
groups and creating few new ones. A user's move locks the chat forever; organizer moves can be
undone; it never reshuffles a chat it already placed. Modes: off, suggest, automatic.

**My day.** Todoist stays the to-do store (Hermes' crons already use it); T3 is the interface. Hermes'
own todo tool is per-session scratch and its kanban board drives agent dispatch, so neither replaces
Todoist. Delegating a to-do starts a Hermes chat; when the agent finishes, the to-do returns for
review and is never completed automatically. New morning briefs raise a T3 notification (web and
desktop), in addition to Hermes' Slack delivery.

## Out of scope for now

Mobile UI for the new surfaces (shared logic lives in `packages/client-runtime` so it can follow),
calendar integration, memory/library views, and specialized finance or fitness screens.

## Maintenance

Personal code lives in `apps/server/src/personal/`, `apps/web/src/personal/`,
`packages/client-runtime/src/personal/` and `packages/contracts/src/personal*.ts`; edits to upstream
files are registration lines. Personal tables are created with `CREATE TABLE IF NOT EXISTS` instead of
numbered migrations, because a personal migration id would make the migrator skip upstream's next
migration after a merge. To take upstream updates: `git fetch upstream && git merge upstream/main` on
the personal branch; conflicts are almost always adjacent registration lines where both sides stay.
