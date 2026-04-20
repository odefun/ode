export type IncomingIgnoreReason =
  | "self_message"
  | "not_mentioned_and_inactive"
  | "not_thread_owner"
  | "empty_text";

export type IncomingFlowResult =
  | { type: "ignore"; reason: IncomingIgnoreReason }
  | { type: "stop"; text: string }
  | { type: "forward"; text: string };

export type IncomingCommand = "setting" | "stats" | "cron";

export function formatIncomingDropMessage(reason: IncomingIgnoreReason): string {
  switch (reason) {
    case "self_message":
      return "[DROP] Self message";
    case "not_mentioned_and_inactive":
      return "[DROP] Not mentioned and thread inactive";
    case "not_thread_owner":
      return "[DROP] Thread message requires owner or mention";
    case "empty_text":
      return "[DROP] Empty text after normalization";
  }
}

export function parseIncomingCommand(text: string): IncomingCommand | null {
  const normalized = text
    .trim()
    .replace(/^／/, "/")
    .replace(/^(?:<@[^>]+>|@[^\s:：,，]+)[:：,，]?\s+/g, "")
    .toLowerCase();
  if (/^\/?settings?\b/.test(normalized)) return "setting";
  if (/^\/?(?:debug\s+)?stats\b/.test(normalized)) return "stats";
  if (/^\/?crons?\b/.test(normalized)) return "cron";
  return null;
}
