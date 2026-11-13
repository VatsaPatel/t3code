import { memo, useState, type ReactNode } from "react";

import ChatMarkdown from "~/components/ChatMarkdown";
import { WorkspacePageContainer } from "~/components/WorkspacePageContainer";
import { ScrollArea } from "~/components/ui/scroll-area";
import { SidebarInset } from "~/components/ui/sidebar";
import { Button } from "~/components/ui/button";
import { formatRelativeTimeLabel } from "~/timestampFormat";

export function PersonalPage({ children }: { readonly children: ReactNode }) {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden">
      <ScrollArea className="min-h-0 flex-1">
        <WorkspacePageContainer>
          <div className="flex max-w-2xl flex-col gap-10 py-10">{children}</div>
        </WorkspacePageContainer>
      </ScrollArea>
    </SidebarInset>
  );
}

export function Section({
  title,
  count,
  aside,
  children,
}: {
  readonly title: string;
  readonly count?: number;
  readonly aside?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium text-muted-foreground">
          {title}
          {count ? (
            <span className="ms-1.5 tabular-nums text-muted-foreground/70">{count}</span>
          ) : null}
        </h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

export function Muted({ children }: { readonly children: ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}

export function relative(iso: string | null): string {
  return iso ? formatRelativeTimeLabel(iso) : "";
}

/** Time until `iso`, e.g. "in 3h"; falls back to the elapsed label for past times. */
export function until(iso: string | null): string {
  if (!iso) return "";
  const ms = new Date(iso).getTime() - Date.now();
  if (Number.isNaN(ms)) return "";
  if (ms <= 0) return relative(iso);
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `in ${Math.max(1, minutes)}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}

export const Markdown = memo(function Markdown({ text }: { readonly text: string }) {
  return <ChatMarkdown text={text} cwd={undefined} />;
});

export const CollapsedMarkdown = memo(function CollapsedMarkdown({
  text,
  lines = 12,
}: {
  readonly text: string;
  readonly lines?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const all = text.split("\n");
  const collapsible = all.length > lines;
  return (
    <div className="flex flex-col items-start gap-1">
      <Markdown text={expanded || !collapsible ? text : all.slice(0, lines).join("\n")} />
      {collapsible ? (
        <Button size="compact" variant="ghost-muted" onClick={() => setExpanded((v) => !v)}>
          {expanded ? "Show less" : "Show more"}
        </Button>
      ) : null}
    </div>
  );
});
