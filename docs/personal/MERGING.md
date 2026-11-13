# Merging upstream into `personal/main`

```sh
git fetch upstream
git checkout personal/main
git merge upstream/main
```

The overlay lives in new paths only:

- `apps/server/src/personal/` — service, sources, curator, separate `personal.sqlite` store, `/api/personal/*` route
- `apps/web/src/personal/`, `apps/web/src/routes/_chat.home.tsx`, `apps/web/src/routes/_chat.routines.tsx`
- `packages/contracts/src/personal.ts`
- `docs/personal/`

## Upstream files touched (registration lines only)

| File                                                | Lines | What                                                                                                              |
| --------------------------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------- |
| `apps/server/src/server.ts`                         | +2    | import `./personal/http.ts`, add `PersonalHttp.layer` next to `speechStreamRouteLayer` in `layerMakeRoutes`       |
| `apps/web/src/components/sidebar/SidebarChrome.tsx` | +2    | import + `<PersonalSidebarItems Item={SidebarUtilityItem} />` after the Usage item                                |
| `packages/contracts/src/index.ts`                   | +1    | `export * from "./personal.ts";`                                                                                  |
| `apps/web/src/routeTree.gen.ts`                     | +42   | generated; on conflict take upstream's and let the Vite router plugin regenerate it (`vp run dev` or a web build) |

## Conflict rules

- **Registration lines:** keep both sides.
- **`routeTree.gen.ts`:** `git checkout --theirs apps/web/src/routeTree.gen.ts`, then start the web dev server once and commit the regenerated file.
- **Database:** personal state is a separate file (`<stateDir>/personal.sqlite`) with `CREATE TABLE IF NOT EXISTS`; it never adds rows to upstream's migration table, so upstream migrations can't collide.
- If upstream moves `SidebarUtilityItem` or `layerMakeRoutes`, re-add the one registration line at the new spot; nothing else depends on upstream internals except `EnvironmentAuth.authenticateHttpRequest`, `ServerConfig.stateDir`, `resolvePrimaryEnvironmentHttpUrl`, `readDesktopPrimaryBearerToken`, `ChatMarkdown` and `WorkspacePageContainer`.

## Last trial merge

Base `24e77473ec` (v0.1.9) + overlay merged `upstream/main` (843 commits ahead, at the time of writing) with **no conflicts** (only `server.ts` auto-merged).

## Hermes provider

No fork code: upstream supports local ACP commands. **Settings → Providers → Add provider → Show more → Local ACP command**, executable `hermes`, argument `acp`.
That gives Hermes chats inside T3. Hermes sessions from Slack/WhatsApp/CLI appear on Home only when they are waiting on you; resume them with the copied `hermes --resume <id>`.

## Running

- Curation needs `OPENROUTER_API_KEY` (read from the login shell if the server env lacks it). Model: `PERSONAL_CURATOR_MODEL` (default `google/gemini-3.8-flash`, routed ZDR-only).
- Overrides: `PERSONAL_HOME_DIR` (where `.hermes`, `.codex`, `.claude` live), `PERSONAL_TODO_SCRIPT`.
- Cost bound: ≤ 25 classifications per 5 minutes, each ≤ ~4 KB in; one digest per day (~30 KB in).
