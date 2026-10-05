/**
 * MCP tools so agents can read and change the personal organization: list a
 * project's groups and file a thread into a workstream/project. Placements
 * are labels only and lock the thread against the background organizer.
 */
import {
  OrchestratorMcpFailure,
  PersonalGroup,
  PersonalGroupName,
  PersonalThreadPlacement,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../../mcp/McpInvocationContext.ts";
import { readCaller } from "../../../mcp/threadAccess.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import { PersonalOrganizationService } from "../PersonalOrganizationService.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    PersonalOrganizationService,
  ],
};

const GroupsListTool = Tool.make("t3_groups_list", {
  ...shared,
  description:
    "List the personal organization groups (workstream, and projects under a workstream) for a T3 project, plus each thread's placement there. Organization is labels only.",
  parameters: Schema.Struct({ projectId: ProjectId }),
  success: Schema.Struct({
    groups: Schema.Array(PersonalGroup),
    placements: Schema.Array(PersonalThreadPlacement),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const ThreadPlaceTool = Tool.make("t3_thread_place", {
  ...shared,
  description:
    "File a thread under a workstream (and optional project) of its own T3 project, creating the groups by name when missing; pass workstream null to move it back to the project root. Never changes the thread's project, cwd, provider, or permissions, and the background organizer will not move it afterwards.",
  parameters: Schema.Struct({
    threadId: ThreadId,
    workstream: Schema.NullOr(PersonalGroupName),
    project: Schema.optional(Schema.NullOr(PersonalGroupName)),
  }),
  success: Schema.Struct({ placement: Schema.NullOr(PersonalThreadPlacement) }),
}).annotate(Tool.Destructive, false);

export const PersonalOrganizationToolkit = Toolkit.make(GroupsListTool, ThreadPlaceTool);

const failure = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

export const PersonalOrganizationToolkitHandlersLive = PersonalOrganizationToolkit.toLayer({
  t3_groups_list: ({ projectId }) =>
    Effect.gen(function* () {
      const { threads } = yield* readCaller();
      const store = yield* PersonalOrganizationService;
      const snapshot = yield* store.getSnapshot().pipe(Effect.mapError((e) => failure(e.message)));
      const groups = snapshot.groups.filter((group) => group.projectId === projectId);
      const shells = yield* threads
        .listProjectThreads({ projectId, includeSubagents: false })
        .pipe(Effect.orElseSucceed(() => []));
      const threadIds = new Set(shells.map((thread) => thread.id));
      return {
        groups,
        placements: snapshot.placements.filter((placement) => threadIds.has(placement.threadId)),
      };
    }),
  t3_thread_place: ({ threadId, workstream, project }) =>
    Effect.gen(function* () {
      yield* readCaller();
      const store = yield* PersonalOrganizationService;
      return yield* store
        .moveThread({
          threadId,
          target:
            workstream === null
              ? { type: "unassigned" }
              : { type: "path", workstream, project: project ?? null },
        })
        .pipe(Effect.mapError((e) => failure(e.message)));
    }),
});
