/**
 * Organization rows for Settings › General: sidebar view, organizer mode,
 * and the organizer's honest status with Run now (primary environment).
 */
import type { PersonalOrganizerMode } from "@t3tools/contracts";

import { Button } from "../../components/ui/button";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { SettingsRow } from "../../components/settings/settingsLayout";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { formatAge } from "../group/GroupPage";
import { usePersonalSidebarView } from "../sidebar/PersonalSidebar";
import { useOrganizationActions } from "./organizationActions";
import { useOrganizationByEnvironment } from "./workspaceTree";

const MODE_LABELS: Record<PersonalOrganizerMode, string> = {
  auto: "Automatic",
  suggest: "Suggest only",
  off: "Off",
};

export function PersonalOrganizationSettingsRows() {
  const [view, setView] = usePersonalSidebarView();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const organization = useOrganizationByEnvironment();
  const status =
    primaryEnvironmentId === null
      ? null
      : (organization.get(primaryEnvironmentId)?.organizer ?? null);
  const { runOrganizer, setOrganizerMode } = useOrganizationActions();

  const statusText = (() => {
    if (status === null) return "Not available on this environment.";
    if (status.mode === "off") return "Off. Chats stay where you put them.";
    if (status.lastRunStatus === "running") return "Filing chats now.";
    const unavailable = status.classifierAvailable
      ? null
      : `Only automatic rules run. ${status.classifierDetail ?? "No text-generation model can classify chats."}`;
    if (status.lastRunStatus === "failed") {
      return `Last run failed: ${status.lastRunError ?? "unknown error"}.`;
    }
    const age = status.lastRunAt === null ? null : formatAge(status.lastRunAt, Date.now());
    const when =
      age === null
        ? null
        : age === "now"
          ? "just now"
          : /(min|hr|day)/.test(age)
            ? `${age} ago`
            : `on ${age}`;
    const last =
      when === null ? "Has not run yet." : `Last run ${when}, filed ${status.lastRunPlaced}.`;
    const pending = status.pendingCount > 0 ? ` ${status.pendingCount} chats waiting.` : "";
    return unavailable ? `${unavailable} ${last}` : `${last}${pending}`;
  })();

  return (
    <>
      <SettingsRow
        title="Sidebar view"
        description="Workspaces groups chats by repo, workstream and project. The flat list is T3's original view."
        control={
          <Select
            value={view}
            onValueChange={(value) => setView(value === "flat" ? "flat" : "tree")}
          >
            <SelectTrigger size="sm" className="w-full sm:w-40" aria-label="Sidebar view">
              <SelectValue>{view === "flat" ? "Flat list" : "Workspaces"}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem hideIndicator value="tree">
                Workspaces
              </SelectItem>
              <SelectItem hideIndicator value="flat">
                Flat list
              </SelectItem>
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        title="Organizer"
        description="Files new chats into workstreams and projects. Your own moves always win."
        status={statusText}
        control={
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={
                status === null || status.mode === "off" || status.lastRunStatus === "running"
              }
              onClick={() => {
                if (primaryEnvironmentId !== null) void runOrganizer(primaryEnvironmentId);
              }}
            >
              Run now
            </Button>
            <Select
              value={status?.mode ?? "auto"}
              disabled={status === null}
              onValueChange={(value) => {
                if (primaryEnvironmentId !== null && value !== null) {
                  void setOrganizerMode(primaryEnvironmentId, value as PersonalOrganizerMode);
                }
              }}
            >
              <SelectTrigger size="sm" className="w-full sm:w-36" aria-label="Organizer mode">
                <SelectValue>{MODE_LABELS[status?.mode ?? "auto"]}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {(Object.keys(MODE_LABELS) as PersonalOrganizerMode[]).map((mode) => (
                  <SelectItem key={mode} hideIndicator value={mode}>
                    {MODE_LABELS[mode]}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
        }
      />
    </>
  );
}
