# Design plan v4 — applying frontend-design + redesign skills

## Subject, audience, job

Subject: a personal command desk where one person directs a personal agent (Hermes) and work agents
(Codex, Claude) across their life and 30–40 projects. Audience: one power user who lives in it all day.
Primary job: "what needs me, what happened, what's next — and get back into any conversation in two
keystrokes." The vernacular of this world is a **daybook**: a dated ledger of correspondence (agents
asking and reporting), standing orders (routines) and obligations (to-dos), with a clear "now".

## Brief constraints that win over novelty

The owner asked to keep T3's design language so the fork stays maintainable. So: T3's tokens, system
sans, icons and components stay. Distinctiveness comes from _structure and typography_, not a new skin.

## Why v3 failed (tells found in my own mockups)

- Middle-dot meta strings everywhere ("Job search · 18m", "41 chats · Hermes, Claude").
- "WORD — fragment" lines ("Morning brief · 8:00 AM — Read", "2 agents working — …").
- A small label above every list; a "Good morning, <name>" greeting (AI-assistant cliché).
- Everything centered; filled-button + ghost-button pairs; folder icons on every tree row.
- No point of view: it looked like every AI chat home.

## Tokens (all existing T3 tokens)

- Color: background `neutral-950` (dark) / `zinc-25` (light); surface `--card`; hairline `--border`
  (white 6%); text `--foreground`, secondary `--muted-foreground`; one accent = T3 `--primary` blue;
  semantic only for state: `--warning` amber (waiting on you), `--success` emerald (working),
  `--destructive` red (failed). No new hues, no gradients beyond T3's existing sidebar header.
- Type: T3 system sans. Scale (px): 28/600 tracking -0.02em for the one date heading; 15/500 titles;
  14/400 body; 12.5/400 secondary. **Tabular numerals** for every time and count (the ledger gutter).
- Space: 8px grid; sections separated by 40px; row height 36–44px; one left-aligned column, max 720px,
  left edge aligned to a 64px time gutter.
- Shape: T3's existing radii; no new cards — rows and hairlines only. Icons: T3's existing set,
  used only where they carry meaning (clock for routine runs, check circle for to-dos).

## Layout concepts (ASCII)

Home — the daybook (left-aligned, not centered):

```
Sunday 5 October                                        (28px, the one bold moment)

[ Ask Hermes…                                  Hermes ▾  🎙  ↑ ]

Waiting on you
  Goodfire cover letter                                    Reply
  Which draft should I send, A or B?          Job search, 18 min
  WHOOP coach                                              Reply
  Want a deload week?                             Health, 1 hour

08:00   Morning brief                                       Read
09:00   WHOOP health coach ran
10:42   Portfolio refresh finished                          Open
───────────────────── now 11:20 ─────────────────────   (thin primary rule)
        ○ Pay credit card bill
        ○ Book flight SFO → PHL
18:00   ○ Gym, upper body
        + Add to-do
```

The "now" rule is the single memorable element: past events above it (agent reports, routine runs,
briefs), open obligations below it. Working agents appear as a live line at the "now" rule
("2 agents working: Portfolio refresh, job scan").

Group page:

```
personal-git /
Job search                                             + New chat   …

Goodfire research engineer cover letter                      18 min  ●
Which draft should I send?
Anthropic referral follow-up                                  2 hours
Drafted a short note to Priya
Lead radar digest, 5 Oct                                 Cron  3 hours
…
Applications       12 chats
Lead radar         29 chats
Show 22 older chats
```

No section labels except "Projects" when sub-projects exist; ordering does the work (waiting first).

Routines: the same time gutter as Home ("08:00 Daily life brief / every day"), detail panel on the
right with the last output rendered and history.

## Principles

1. One bold moment per screen (Home: the date + now rule). Everything else quiet.
2. Time is the organizing axis of a personal agent; show it in a consistent tabular gutter.
3. Words do one job: plain sentence case, no dot-joined meta, no em-dash fragments, no greetings.
4. Ordering and alignment encode priority; labels only where structure needs naming.

## Review against the brief

Is this the default for any "AI assistant home"? The default is a centered greeting + composer +
cards. The daybook with a "now" rule, a tabular time gutter and left alignment is specific to a
personal agent that acts over a day. It reuses T3 tokens, so it stays maintainable. Revised from v3:
removed greeting, centered layout, dot meta strings, filled/ghost button pairs, folder icons.
