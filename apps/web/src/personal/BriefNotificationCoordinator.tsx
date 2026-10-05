import { useNavigate } from "@tanstack/react-router";
import { parseIso } from "@t3tools/client-runtime/personal/daybook";
import type { EnvironmentId, PersonalTodayBriefArrived } from "@t3tools/contracts";
import { NewspaperIcon } from "lucide-react";
import { useEffect, useRef } from "react";

import { toastManager } from "../components/ui/toast";
import { getClientSettings, useClientSettings } from "../hooks/useSettings";
import { usePrimaryEnvironmentId } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import {
  hasDesktopNotifications,
  hasNotificationSound,
  playNotificationSound,
} from "../threadNotifications";
import { personalTodayEnvironment } from "./personalToday";

function briefTitle(arrival: PersonalTodayBriefArrived): string {
  const at = parseIso(arrival.runAt);
  return /brief/i.test(arrival.jobName) && at !== null && at.getHours() < 12
    ? "Morning brief ready"
    : `${arrival.jobName} is ready`;
}

function BriefNotifications({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const navigate = useNavigate();
  const arrival = useEnvironmentQuery(
    personalTodayEnvironment.briefArrivals({ environmentId, input: {} }),
  ).data;
  const announced = useRef<string | null>(null);

  useEffect(() => {
    if (arrival == null) return;
    const key = `${arrival.jobId}:${arrival.runStamp}`;
    if (announced.current === key) return;
    announced.current = key;
    const { notificationMode: mode, inAppNotificationsEnabled } = getClientSettings();
    const title = briefTitle(arrival);
    const openHome = () => void navigate({ to: "/home" });
    if (hasNotificationSound(mode)) {
      void playNotificationSound("completion", () =>
        hasNotificationSound(getClientSettings().notificationMode),
      );
    }
    const focused = document.visibilityState === "visible" && document.hasFocus();
    if (focused) {
      if (!inAppNotificationsEnabled) return;
      const toastId = toastManager.add({
        type: "info",
        title,
        description: arrival.firstLine,
        data: {
          hideCopyButton: true,
          leadingIcon: <NewspaperIcon aria-hidden className="size-4 text-info-foreground" />,
        },
        actionProps: {
          children: "Read",
          onClick: () => {
            toastManager.close(toastId);
            openHome();
          },
        },
      });
      return;
    }
    if (
      !hasDesktopNotifications(mode) ||
      typeof Notification === "undefined" ||
      Notification.permission !== "granted"
    ) {
      return;
    }
    try {
      const notification = new Notification(title, {
        body: arrival.firstLine,
        tag: `brief:${key}`,
        silent: true,
      });
      notification.addEventListener("click", () => {
        notification.close();
        window.focus();
        openHome();
      });
    } catch {
      // Some browsers expose Notification but refuse to show it.
    }
  }, [arrival, navigate]);

  return null;
}

/**
 * Announces new Hermes briefs from the primary environment as a notification
 * that opens Home. Follows the thread notification settings. The server only
 * reports briefs that land while it runs, so a restart never replays one.
 * Mobile push is not covered.
 */
export function BriefNotificationCoordinator() {
  const environmentId = usePrimaryEnvironmentId();
  const mode = useClientSettings((settings) => settings.notificationMode);
  const inApp = useClientSettings((settings) => settings.inAppNotificationsEnabled);
  if (environmentId === null || (mode === "off" && !inApp)) return null;
  return <BriefNotifications environmentId={environmentId} />;
}
