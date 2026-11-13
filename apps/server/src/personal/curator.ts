// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalConsole:off globalFetch:off globalTimers:off -- fork-only plain-Node module; reads foreign files synchronously on a bounded timer.
/**
 * Cheap background curation through OpenRouter (zero-data-retention routing). Separate from
 * upstream TextGeneration because these calls run unattended on a timer and must stay cheap and
 * bounded; T3's text generation model defaults to starting a full agent session per request.
 */
export const CURATOR_MODEL = process.env.PERSONAL_CURATOR_MODEL ?? "google/gemini-3.8-flash";

import * as NodeChildProcess from "node:child_process";

let resolvedKey: string | null | undefined;
// Servers launched from desktop/systemd miss login-shell exports; read the key once from there.
function apiKey(): string | null {
  if (resolvedKey !== undefined) return resolvedKey;
  resolvedKey = process.env.OPENROUTER_API_KEY ?? null;
  if (!resolvedKey) {
    try {
      resolvedKey =
        NodeChildProcess.execFileSync("bash", ["-lc", 'printf %s "$OPENROUTER_API_KEY"'], {
          timeout: 5_000,
          encoding: "utf8",
        }).trim() || null;
    } catch {
      resolvedKey = null;
    }
  }
  return resolvedKey;
}

export const curatorAvailable = () => apiKey() !== null;

export async function complete(
  system: string,
  user: string,
  options: { readonly maxTokens: number; readonly json?: boolean; readonly timeoutMs?: number },
): Promise<string> {
  const key = apiKey();
  if (!key) throw new Error("OPENROUTER_API_KEY is not set");
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "X-Title": "T3 Code personal curator",
    },
    body: JSON.stringify({
      model: CURATOR_MODEL,
      // Reasoning models spend the token budget thinking and return empty content otherwise.
      max_tokens: options.maxTokens + 1024,
      reasoning: { effort: "low", exclude: true },
      temperature: 0,
      provider: { data_collection: "deny", zdr: true },
      ...(options.json ? { response_format: { type: "json_object" } } : {}),
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!response.ok)
    throw new Error(`OpenRouter ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const body = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = body.choices?.[0]?.message?.content;
  if (typeof text !== "string") throw new Error("OpenRouter returned no content");
  return text;
}

export function parseJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const value: unknown = JSON.parse(text.slice(start, end + 1));
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
