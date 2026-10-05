import { createFileRoute } from "@tanstack/react-router";

import { GroupPage } from "../personal/group/GroupPage";

export const Route = createFileRoute("/_chat/groups/$environmentId/$groupId")({
  component: GroupRouteView,
});

function GroupRouteView() {
  const { environmentId, groupId } = Route.useParams();
  return <GroupPage environmentId={environmentId} groupId={groupId} />;
}
