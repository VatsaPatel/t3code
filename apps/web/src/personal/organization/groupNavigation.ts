import type { OrganizedGroupMember } from "@t3tools/client-runtime/personal/organizationTree";
import type { EnvironmentId } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { useCallback } from "react";

import { usePrimaryEnvironmentId } from "../../state/environments";

/** The member a merged group opens as: the primary environment's when it has one. */
export function preferredGroupMember<M extends { environmentId: string }>(
  members: ReadonlyArray<M>,
  primaryEnvironmentId: string | null,
): M | null {
  return (
    members.find((member) => member.environmentId === primaryEnvironmentId) ?? members[0] ?? null
  );
}

export function useOpenGroupPage() {
  const router = useRouter();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  return useCallback(
    (members: ReadonlyArray<OrganizedGroupMember>) => {
      const member = preferredGroupMember(members, primaryEnvironmentId);
      if (member === null) return;
      void router.navigate({
        to: "/groups/$environmentId/$groupId",
        params: { environmentId: member.environmentId as EnvironmentId, groupId: member.groupId },
      });
    },
    [primaryEnvironmentId, router],
  );
}
