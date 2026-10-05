import { resolveGroupPath } from "@t3tools/client-runtime/personal/organizationTree";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import {
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "../../components/WorkspaceBreadcrumb";
import { useOpenGroupPage } from "../organization/groupNavigation";
import { useOrganizationByEnvironment } from "../organization/workspaceTree";

/** "Job search / Applications /" between the project and the chat title. */
export function GroupBreadcrumbItems(props: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
}) {
  const organization = useOrganizationByEnvironment();
  const openGroupPage = useOpenGroupPage();
  if (props.environmentId === null || props.threadId === null) return null;
  const state = organization.get(props.environmentId);
  const groupId = state?.placementsByThreadId[props.threadId]?.groupId ?? null;
  if (!state || groupId === null) return null;
  const group = state.groupsById[groupId];
  if (!group) return null;
  const parent = group.parentId === null ? undefined : state.groupsById[group.parentId];
  const chain = parent ? [parent, group] : [group];
  if (resolveGroupPath(state, groupId).length === 0) return null;
  return chain.map((entry) => (
    <GroupCrumb
      key={entry.id}
      name={entry.name}
      onClick={() =>
        openGroupPage([
          { environmentId: props.environmentId!, projectId: entry.projectId, groupId: entry.id },
        ])
      }
    />
  ));
}

function GroupCrumb(props: { readonly name: string; readonly onClick: () => void }) {
  return (
    <>
      <WorkspaceBreadcrumbItem className="shrink">
        <button
          type="button"
          onClick={props.onClick}
          className="inline-flex min-w-0 max-w-full cursor-pointer items-center rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
        >
          <WorkspaceBreadcrumbText className="max-w-40">{props.name}</WorkspaceBreadcrumbText>
        </button>
      </WorkspaceBreadcrumbItem>
      <WorkspaceBreadcrumbSeparator>
        <WorkspaceBreadcrumbText>/</WorkspaceBreadcrumbText>
      </WorkspaceBreadcrumbSeparator>
    </>
  );
}
