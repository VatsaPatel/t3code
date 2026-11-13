import { useEffect, useState } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";

import { readDesktopPrimaryBearerToken } from "~/environments/primary/desktopAuth";
import { resolvePrimaryEnvironmentHttpUrl } from "~/environments/primary/target";

import type {
  PersonalBrief,
  PersonalDigestResult,
  PersonalRoutineAction,
  PersonalRoutinesResult,
  PersonalTodosResult,
  PersonalWaitingResult,
} from "@t3tools/contracts";

export type {
  PersonalBrief,
  PersonalDigestResult,
  PersonalRoutine,
  PersonalRoutineAction,
  PersonalRoutinesResult,
  PersonalTodo,
  PersonalTodosResult,
  PersonalWaitingItem,
  PersonalWaitingResult,
} from "@t3tools/contracts";

function isSameOriginBrowserPrimary(url: string): boolean {
  if (
    typeof window === "undefined" ||
    window.desktopBridge !== undefined ||
    !window.location.origin.startsWith("http")
  ) {
    return false;
  }
  return new URL(url).origin === window.location.origin;
}

async function request<T>(path: string, body?: unknown): Promise<T> {
  const [pathname = path, query] = path.split("?");
  const url = resolvePrimaryEnvironmentHttpUrl(
    pathname,
    query ? Object.fromEntries(new URLSearchParams(query)) : undefined,
  );
  const headers: Record<string, string> = {};
  let credentials: RequestCredentials = "include";
  if (!isSameOriginBrowserPrimary(url)) {
    credentials = "omit";
    const token = await readDesktopPrimaryBearerToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(url, {
    method: body === undefined ? "GET" : "POST",
    headers,
    credentials,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    const message =
      json && typeof json === "object" && "error" in json && typeof json.error === "string"
        ? json.error
        : `Request failed (${response.status})`;
    throw new Error(message);
  }
  return json as T;
}

export const personalApi = {
  waiting: () => request<PersonalWaitingResult>("/api/personal/waiting"),
  dismiss: (key: string, dismissed: boolean) =>
    request<{ ok: true }>("/api/personal/waiting/dismiss", { key, dismissed }),
  digest: () => request<PersonalDigestResult>("/api/personal/digest"),
  refreshDigest: () => request<PersonalDigestResult>("/api/personal/digest/refresh", {}),
  todos: () => request<PersonalTodosResult>("/api/personal/todos"),
  completeTodo: (id: string) => request<{ ok: true }>("/api/personal/todos/done", { id }),
  addTodo: (text: string, due?: string) =>
    request<{ ok: true; id: string }>("/api/personal/todos/add", due ? { text, due } : { text }),
  brief: () => request<PersonalBrief | null>("/api/personal/brief"),
  routines: () => request<PersonalRoutinesResult>("/api/personal/routines"),
  routineAction: (id: string, action: PersonalRoutineAction) =>
    request<{ ok: true; message: string }>("/api/personal/routines/action", { id, action }),
  routineOutput: (id: string) =>
    request<{ markdown: string | null; ranAt: string | null }>(
      `/api/personal/routines/output?id=${encodeURIComponent(id)}`,
    ),
};

export interface Resource<T> {
  readonly data: T | undefined;
  readonly error: string | null;
  readonly loading: boolean;
  readonly refetch: () => Promise<void>;
}

/** Fetches on mount; with `pollMs`, refetches while the page is visible. */
export function useResource<T>(load: () => Promise<T>, pollMs?: number): Resource<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const refetch = useStableCallback(async () => {
    setLoading(true);
    try {
      setData(await load());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads from the personal HTTP API on mount and polls it while the tab is visible
  useEffect(() => {
    void refetch();
    if (!pollMs) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refetch();
    }, pollMs);
    const onVisible = () => {
      if (document.visibilityState === "visible") void refetch();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refetch, pollMs]);

  return { data, error, loading, refetch };
}
