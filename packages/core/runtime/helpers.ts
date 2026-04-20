import type { NormalizedQuestion } from "@/core/types";

export type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

export function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

export function buildFinalResponseText(responses: Array<{ text?: string }>): string | null {
  const texts = responses
    .map((response) => response.text?.trim())
    .filter((text): text is string => Boolean(text));
  if (texts.length === 0) return null;
  return texts.join("\n\n");
}

export function categorizeRuntimeError(
  err: unknown
): { message: string; suggestion: string } {
  const errorStr = err instanceof Error ? err.message : String(err);

  if (errorStr.includes("timeout") || errorStr.includes("timed out") || errorStr.includes("ETIMEDOUT")) {
    return {
      message: "Request timed out",
      suggestion: "The operation took too long. Try a simpler request or break it into smaller steps.",
    };
  }

  if (errorStr.includes("rate limit") || errorStr.includes("429")) {
    return {
      message: "Rate limited",
      suggestion: "Too many requests. Please wait a moment and try again.",
    };
  }

  if (errorStr.includes("authentication") || errorStr.includes("401") || errorStr.includes("403")) {
    return {
      message: "Authentication error",
      suggestion: "There may be an issue with API credentials. Contact your administrator.",
    };
  }

  if (
    errorStr.includes("ConnectionRefused") ||
    errorStr.includes("ECONNREFUSED") ||
    errorStr.includes("ENOTFOUND") ||
    errorStr.includes("network")
  ) {
    const serverUrl = process.env.ODE_OPENCODE_SERVER_URL?.trim() || "http://127.0.0.1:4096";
    const message = serverUrl
      ? `OpenCode server not accessible on ${serverUrl}`
      : "OpenCode server not accessible";
    return {
      message,
      suggestion: "Check that the OpenCode server is running and reachable.",
    };
  }

  if (errorStr.includes("empty response")) {
    return {
      message: "No response received",
      suggestion: "The model didn't generate a response. Try rephrasing your request.",
    };
  }

  return {
    message: errorStr.length > 100 ? `${errorStr.slice(0, 100)}...` : errorStr,
    suggestion: "If this persists, try starting a new thread or contact support.",
  };
}

export function formatQuestionPrompt(questions: NormalizedQuestion[]): string {
  const lines = questions.map((question, index) => {
    const prefix = questions.length > 1 ? `${index + 1}. ` : "";
    const optionText = question.options?.length
      ? `\nOptions: ${question.options.join(" / ")}`
      : "";
    return `${prefix}${question.question}${optionText}`;
  });

  return lines.join("\n\n");
}

/**
 * Format a single question in a multi-question flow. Shows a `(i/N)` marker
 * so the user knows how many answers are still expected.
 */
export function formatSingleQuestionPrompt(
  question: NormalizedQuestion,
  index: number,
  total: number
): string {
  const prefix = total > 1 ? `(${index + 1}/${total}) ` : "";
  const optionText = question.options?.length
    ? `\nOptions: ${question.options.join(" / ")}`
    : "";
  return `${prefix}${question.question}${optionText}`;
}

/**
 * Wrap an array of per-question answer strings into the nested shape that
 * `AgentAdapter.replyToQuestion` expects (`Array<Array<string>>`).
 *
 * We no longer split a single incoming message by newlines to spread it
 * across multiple questions — multi-question flows ask one at a time and
 * accumulate answers, so each entry here is already one user reply.
 */
export function buildQuestionAnswers(answers: string[]): Array<Array<string>> {
  return answers.map((answer) => [answer]);
}

/**
 * Heuristic for rendering a question's options as interactive UI (e.g. Slack
 * buttons) rather than plain "a / b / c" text. We promote to buttons whenever
 * each option fits within Slack's native button-text limit (75 chars) and the
 * count stays within Slack's actions-block comfort zone.
 */
export function hasSimpleOptions(options: readonly string[] | undefined): boolean {
  if (!options) return false;
  if (options.length < 2 || options.length > 5) return false;
  for (const opt of options) {
    const trimmed = opt?.trim?.();
    if (!trimmed) return false;
    if (trimmed.length > 75) return false;
    if (/[\r\n]/.test(trimmed)) return false;
  }
  return true;
}
