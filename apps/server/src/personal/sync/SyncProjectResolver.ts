/**
 * SyncProjectResolver - pick the T3 project a synced native session belongs to.
 *
 * 1. A cwd inside an existing project's workspace root belongs to that project
 *    (longest root wins).
 * 2. A cwd inside a Git checkout belongs to the project for the repository's
 *    main checkout (linked worktrees resolve to it); the project is created
 *    once, with ids derived from the root so a repeat is a no-op.
 * 3. Everything else (no cwd, the home directory, Slack or cron sessions) goes
 *    to the home project: the configured folder, else `~/repos/personal-git`
 *    when it exists, else the "No project" scratch project.
 *
 * Callers resolve only for new threads; an existing thread never moves.
 *
 * @module personal/sync/SyncProjectResolver
 */
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";

import { CommandId, ProjectId } from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerConfig from "../../config.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import { expandHomePath } from "../../pathExpansion.ts";
import * as ManagedProjectFolders from "../../project/ManagedProjectFolders.ts";
import * as ProjectService from "../../project/ProjectService.ts";

interface KnownProject {
  readonly id: ProjectId;
  readonly root: string;
}

const withSeparator = (value: string) => (value.endsWith("/") ? value : `${value}/`);

/** UUID-shaped id derived from the root, so creating the same project twice is idempotent. */
const deterministicProjectId = (root: string) => {
  const hex = NodeCrypto.createHash("sha256").update(`personal-sync:${root}`).digest("hex");
  return ProjectId.make(
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`,
  );
};

/** Built once per sync pass; caches the project list and resolved Git roots. */
export const makeSyncProjectResolver = Effect.fn("SyncProjectResolver.make")(function* (input: {
  readonly homeProjectPath: string | null;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const projectStore = yield* ProjectStore.ProjectStoreV2;
  const projects = yield* ProjectService.ProjectService;
  const projectFolders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const homeDir = path.resolve(NodeOS.homedir());
  const baseDir = withSeparator(normalizeProjectPathForComparison(path.resolve(config.baseDir)));

  const known: Array<KnownProject> = (yield* projectStore.listShells()).map((shell) => ({
    id: shell.id,
    root: normalizeProjectPathForComparison(path.resolve(expandHomePath(shell.workspaceRoot))),
  }));
  const gitRoots = new Map<string, string | null>();
  let homeProject: ProjectId | null = null;

  const containing = (target: string): KnownProject | undefined => {
    const normalized = withSeparator(normalizeProjectPathForComparison(target));
    let best: KnownProject | undefined;
    for (const project of known) {
      if (!normalized.startsWith(withSeparator(project.root))) continue;
      if (best === undefined || project.root.length > best.root.length) best = project;
    }
    return best;
  };

  const isDirectory = (target: string) =>
    fileSystem.stat(target).pipe(
      Effect.map((info) => info.type === "Directory"),
      Effect.orElseSucceed(() => false),
    );

  /** The main checkout for `start`, or null outside Git (the home dir is never a repo root). */
  const findRepositoryRoot = Effect.fn("SyncProjectResolver.findRepositoryRoot")(function* (
    start: string,
  ) {
    let directory = start;
    while (directory !== homeDir && directory !== path.dirname(directory)) {
      const cached = gitRoots.get(directory);
      if (cached !== undefined) return cached;
      const gitPath = path.join(directory, ".git");
      const info = yield* fileSystem.stat(gitPath).pipe(Effect.option);
      if (Option.isSome(info)) {
        let root = directory;
        if (info.value.type !== "Directory") {
          const pointer = yield* fileSystem
            .readFileString(gitPath)
            .pipe(Effect.orElseSucceed(() => ""));
          const gitDir = /^gitdir:\s*(.+)$/m.exec(pointer)?.[1]?.trim();
          // `<main>/.git/worktrees/<name>` marks a linked worktree.
          if (gitDir !== undefined) {
            const resolved = path.resolve(directory, gitDir);
            if (path.basename(path.dirname(resolved)) === "worktrees") {
              root = path.dirname(path.dirname(path.dirname(resolved)));
            }
          }
        }
        gitRoots.set(start, root);
        return root;
      }
      directory = path.dirname(directory);
    }
    gitRoots.set(start, null);
    return null;
  });

  const ensureProjectAt = Effect.fn("SyncProjectResolver.ensureProjectAt")(function* (
    root: string,
  ) {
    const existing = containing(root);
    if (existing !== undefined) return existing.id;
    const projectId = deterministicProjectId(root);
    const created = yield* projects
      .bootstrap({
        commandId: CommandId.make(`personal-sync:project:${projectId}`),
        projectId,
        title: path.basename(root) || root,
        workspaceRoot: root,
      })
      .pipe(
        Effect.map((result) => result.project.id),
        Effect.catchTag("ProjectConflictError", (conflict) =>
          Effect.succeed(conflict.conflictingProjectId),
        ),
      );
    known.push({ id: created, root: normalizeProjectPathForComparison(root) });
    return created;
  });

  const resolveHomeProject = Effect.gen(function* () {
    if (homeProject !== null) return homeProject;
    const configured =
      input.homeProjectPath === null
        ? path.join(homeDir, "repos", "personal-git")
        : path.resolve(expandHomePath(input.homeProjectPath));
    homeProject = (yield* isDirectory(configured))
      ? yield* ensureProjectAt(configured)
      : (yield* projectFolders.ensureScratchProject).projectId;
    return homeProject;
  });

  const resolve = Effect.fn("SyncProjectResolver.resolve")(function* (cwd: string | null) {
    const expanded = cwd === null ? null : expandHomePath(cwd.trim());
    if (expanded === null || !path.isAbsolute(expanded)) return yield* resolveHomeProject;
    const target = path.resolve(expanded);
    if (target === homeDir) return yield* resolveHomeProject;
    const direct = containing(target);
    if (direct !== undefined) return direct.id;
    if (!(yield* isDirectory(target))) return yield* resolveHomeProject;
    const repositoryRoot = yield* findRepositoryRoot(target);
    // T3's own data dir (worktrees, scratch) never becomes a new project.
    if (
      repositoryRoot === null ||
      withSeparator(normalizeProjectPathForComparison(repositoryRoot)).startsWith(baseDir)
    ) {
      return yield* resolveHomeProject;
    }
    return yield* ensureProjectAt(repositoryRoot);
  });

  return { resolve };
});
