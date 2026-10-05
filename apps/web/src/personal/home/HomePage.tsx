import { selectTodayAttention } from "@t3tools/client-runtime/personal/today";
import { useMemo } from "react";

import { ScrollArea } from "../../components/ui/scroll-area";
import { SidebarInset } from "../../components/ui/sidebar";
import { WorkspacePageHeader } from "../../components/WorkspacePageHeader";
import { isElectron } from "../../env";
import { useThreadShells } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { personalTodayEnvironment } from "../personalToday";
import { DayLedger } from "./DayLedger";
import { HomeComposer, useDefaultSelection } from "./HomeComposer";
import { formatDayHeading, useNow } from "./time";
import { WaitingOnYou } from "./WaitingOnYou";

/**
 * Home: a daybook for the day. The date, a composer that asks Hermes, what is
 * waiting on the user, and a ledger split by a "now" rule into what happened
 * and what is still open.
 */
export function HomePage() {
  const environmentId = usePrimaryEnvironmentId();
  const now = useNow();
  const threads = useThreadShells();
  const attention = useMemo(() => selectTodayAttention(threads), [threads]);
  const snapshot = useEnvironmentQuery(
    environmentId === null ? null : personalTodayEnvironment.live({ environmentId, input: {} }),
  ).data;

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <h1 className="text-sm font-medium text-foreground">Home</h1>
        </WorkspacePageHeader>
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex w-full max-w-[49rem] flex-col gap-10 px-6 pt-12 pb-16 sm:px-12">
            <h2 className="text-3xl leading-tight font-semibold tracking-tight text-foreground">
              {formatDayHeading(now)}
            </h2>
            {environmentId !== null ? (
              <>
                <div className="-mt-4">
                  <HomeComposer environmentId={environmentId} />
                </div>
                <WaitingOnYou items={attention.needsYou} nowMs={now.getTime()} />
                <HomeLedger
                  environmentId={environmentId}
                  snapshot={snapshot}
                  threads={threads}
                  working={attention.working}
                  now={now}
                />
              </>
            ) : null}
          </div>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}

function HomeLedger(props: Omit<Parameters<typeof DayLedger>[0], "fallbackModelSelection">) {
  const { fallback } = useDefaultSelection(props.environmentId);
  return <DayLedger {...props} fallbackModelSelection={fallback} />;
}
