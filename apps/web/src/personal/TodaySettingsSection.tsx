import type { PersonalTodayRoutine, PersonalTodaySettingsPatch } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";

import { Input } from "../components/ui/input";
import {
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../components/ui/menu";
import { Button } from "../components/ui/button";
import { Switch } from "../components/ui/switch";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { SettingsRow, SettingsSection } from "../components/settings/settingsLayout";
import { usePrimaryEnvironmentId } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";
import { personalTodayEnvironment } from "./personalToday";

function JobPicker({
  label,
  automaticLabel,
  routines,
  value,
  onChange,
}: {
  readonly label: string;
  readonly automaticLabel: string;
  readonly routines: ReadonlyArray<PersonalTodayRoutine>;
  readonly value: ReadonlyArray<string> | null;
  readonly onChange: (next: ReadonlyArray<string> | null) => void;
}) {
  const selected = new Set(value ?? []);
  const summary =
    value === null
      ? automaticLabel
      : value.length === 0
        ? "None"
        : routines
            .filter((routine) => selected.has(routine.id))
            .map((routine) => routine.name)
            .join(", ") || `${value.length} jobs`;
  return (
    <Menu>
      <MenuTrigger render={<Button size="sm" variant="outline" aria-label={label} />}>
        <span className="max-w-56 truncate">{summary}</span>
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuItem onClick={() => onChange(null)}>{automaticLabel}</MenuItem>
        <MenuSeparator />
        {routines.map((routine) => (
          <MenuCheckboxItem
            key={routine.id}
            checked={selected.has(routine.id)}
            onCheckedChange={(checked) => {
              const next = new Set(selected);
              if (checked) next.add(routine.id);
              else next.delete(routine.id);
              onChange([...next]);
            }}
          >
            {routine.name}
          </MenuCheckboxItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}

function TokenCommandInput({
  stored,
  onSave,
}: {
  readonly stored: string;
  readonly onSave: (command: string) => void;
}) {
  const [command, setCommand] = useState(stored);
  return (
    <Input
      size="sm"
      className="w-full sm:w-64"
      value={command}
      aria-label="Todoist token command"
      onChange={(event) => setCommand(event.target.value)}
      onBlur={() => {
        if (command !== stored) onSave(command);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
      }}
    />
  );
}

/** Home settings: where to-dos come from and which Hermes jobs are briefs. Host-wide. */
export function TodaySettingsSection() {
  const environmentId = usePrimaryEnvironmentId();
  const snapshot = useEnvironmentQuery(
    environmentId === null ? null : personalTodayEnvironment.live({ environmentId, input: {} }),
  ).data;
  const update = useAtomCommand(personalTodayEnvironment.updateSettings, { reportFailure: false });
  const settings = snapshot?.settings ?? null;
  if (environmentId === null || settings === null) return null;
  const routines = snapshot?.cron.routines ?? [];

  const save = (patch: PersonalTodaySettingsPatch) => {
    void update({ environmentId, input: patch }).then((result) => {
      if (result._tag === "Failure") {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not save Home settings",
            description: error instanceof Error ? error.message : "Try again.",
          }),
        );
      }
    });
  };

  return (
    <SettingsSection id="home-today" title="Home">
      <SettingsRow
        title="Todoist to-dos"
        description="Show today's to-dos on Home. The token comes from TODOIST_API_TOKEN or the command below."
        control={
          <Switch
            checked={settings.todoistEnabled}
            onCheckedChange={(checked) => save({ todoistEnabled: checked })}
            aria-label="Show Todoist to-dos"
          />
        }
      />
      <SettingsRow
        title="Token command"
        description="Runs on this machine and prints the Todoist API token. The token is never logged."
        control={
          <TokenCommandInput
            key={settings.todoistTokenCommand}
            stored={settings.todoistTokenCommand}
            onSave={(command) => save({ todoistTokenCommand: command })}
          />
        }
      />
      <SettingsRow
        title="Brief jobs"
        description="Hermes cron jobs shown as the morning brief on Home."
        control={
          <JobPicker
            label="Brief jobs"
            automaticLabel="Jobs named brief"
            routines={routines}
            value={settings.briefJobIds}
            onChange={(next) => save({ briefJobIds: next })}
          />
        }
      />
      <SettingsRow
        title="Notify when ready"
        description="Hermes cron jobs that raise a T3 notification when new output lands."
        control={
          <JobPicker
            label="Jobs that notify"
            automaticLabel="Same as brief jobs"
            routines={routines}
            value={settings.notifyJobIds}
            onChange={(next) => save({ notifyJobIds: next })}
          />
        }
      />
    </SettingsSection>
  );
}
