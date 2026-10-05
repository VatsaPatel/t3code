import { useState } from "react";

import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";

/** Name prompt for renaming a group or creating a project under it. */
export function GroupNameDialog(props: {
  readonly title: string;
  readonly initialName: string;
  readonly onCancel: () => void;
  readonly onSubmit: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(props.initialName);
  const [saving, setSaving] = useState(false);
  const trimmed = name.trim();
  const valid = trimmed.length > 0 && trimmed.length <= 40;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onCancel();
      }}
    >
      <DialogPopup className="sm:max-w-sm">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!valid || saving) return;
            setSaving(true);
            await props.onSubmit(trimmed);
            setSaving(false);
          }}
        >
          <DialogHeader>
            <DialogTitle>{props.title}</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <Input
              autoFocus
              aria-label="Name"
              value={name}
              maxLength={40}
              onChange={(event) => setName(event.target.value)}
            />
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={props.onCancel}>
              Cancel
            </Button>
            <Button type="submit" disabled={!valid || saving}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
