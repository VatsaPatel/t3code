import type { NeedsYouItem } from "@t3tools/client-runtime/personal/today";
import { formatAge } from "@t3tools/client-runtime/personal/daybook";
import { resolveGroupPath } from "@t3tools/client-runtime/personal/organizationTree";
import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";

import { InlineButton } from "../../components/ui/button";
import { useProjects } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { personalOrganizationEnvironment } from "../personalOrganization";
import { personalTodayEnvironment } from "../personalToday";

const FALLBACK_TEXT = {
  approval: "Waiting for your approval.",
  input: "Has a question for you.",
  plan: "A plan is ready for you to review.",
} as const;

/** The group a chat is filed under, else its project; chats with no project read "Personal". */
export function useChatGroupName(environmentId: EnvironmentId) {
  const organization = useEnvironmentQuery(
    personalOrganizationEnvironment.organizationLive({ environmentId, input: {} }),
  ).data;
  const projects = useProjects();
  return (thread: NeedsYouItem["thread"]): string | null => {
    const groupId = organization?.placementsByThreadId[thread.id]?.groupId ?? null;
    const path = resolveGroupPath(organization, groupId);
    if (path.length > 0) return path[path.length - 1]!;
    const project = projects.find(
      (candidate) =>
        candidate.environmentId === thread.environmentId && candidate.id === thread.projectId,
    );
    if (project === undefined) return null;
    return project.title === "No project" ? "Personal" : project.title;
  };
}

function WaitingRows({
  environmentId,
  items,
  nowMs,
}: {
  readonly environmentId: EnvironmentId;
  readonly items: ReadonlyArray<NeedsYouItem>;
  readonly nowMs: number;
}) {
  const navigate = useNavigate();
  const groupName = useChatGroupName(environmentId);
  const threadIds = useMemo(
    () =>
      items
        .map((item) => item.thread.id)
        .sort()
        .slice(0, 50),
    [items],
  );
  const prompts = useEnvironmentQuery(
    personalTodayEnvironment.pendingPrompts({ environmentId, input: { threadIds } }),
  );
  // A new question on the same chat keeps the input identical; refetch when it changes.
  const requestKey = items
    .map((item) => item.thread.source.pendingRuntimeRequest?.id ?? item.kind)
    .join(",");
  const { refresh } = prompts;
  useEffect(() => {
    refresh();
  }, [refresh, requestKey]);
  const promptByThread = new Map(
    (prompts.data?.prompts ?? []).map((prompt) => [prompt.threadId, prompt.text]),
  );

  return items.map((item) => {
    const group = groupName(item.thread);
    const open = () =>
      void navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId, threadId: item.thread.id },
      });
    return (
      <li
        key={item.thread.id}
        className="grid grid-cols-[1.25rem_minmax(0,1fr)_auto] items-baseline gap-x-2 py-2"
      >
        <span aria-hidden="true" className="size-2 -translate-y-px rounded-full bg-warning" />
        <div className="min-w-0">
          <div className="flex min-w-0 items-baseline gap-2">
            <button
              type="button"
              onClick={open}
              className="min-w-0 truncate text-left text-base font-medium text-foreground hover:underline"
            >
              {item.thread.title}
            </button>
            {group ? (
              <span className="shrink-0 truncate text-xs text-muted-foreground">{group}</span>
            ) : null}
          </div>
          <p className="truncate text-sm text-muted-foreground">
            {promptByThread.get(item.thread.id) ?? FALLBACK_TEXT[item.kind]}
          </p>
        </div>
        <div className="flex items-baseline gap-5 ps-4 text-sm">
          <span className="tabular-nums text-muted-foreground">
            {formatAge(Date.parse(item.waitingSince), nowMs)}
          </span>
          <InlineButton tone="muted" onClick={open}>
            Reply
          </InlineButton>
        </div>
      </li>
    );
  });
}

/** Chats blocked on the user, newest first. Hidden when nothing is waiting. */
export function WaitingOnYou({
  items,
  nowMs,
}: {
  readonly items: ReadonlyArray<NeedsYouItem>;
  readonly nowMs: number;
}) {
  const byEnvironment = useMemo(() => {
    const groups = new Map<EnvironmentId, NeedsYouItem[]>();
    for (const item of items) {
      const list = groups.get(item.thread.environmentId) ?? [];
      list.push(item);
      groups.set(item.thread.environmentId, list);
    }
    return [...groups];
  }, [items]);
  if (items.length === 0) return null;
  return (
    <section aria-labelledby="home-waiting">
      <h2 id="home-waiting" className="mb-1 text-sm font-medium text-muted-foreground">
        Waiting on you
      </h2>
      <ul>
        {byEnvironment.map(([environmentId, list]) => (
          <WaitingRows
            key={environmentId}
            environmentId={environmentId}
            items={list}
            nowMs={nowMs}
          />
        ))}
      </ul>
    </section>
  );
}
