/**
 * Convert markdown to Slack mrkdwn format
 */
export function markdownToSlack(text: string): string {
  // Escape special Slack characters first
  let result = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  // Convert code blocks - preserve them
  // (triple backticks work in Slack)

  // Convert inline code
  // Slack uses single backticks same as markdown

  // Convert bold: **text** -> *text*
  result = result.replace(/\*\*([^*]+)\*\*/g, "*$1*");

  // Convert italic: *text* or _text_ -> _text_
  // Be careful not to match bold markers
  result = result.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "_$1_");

  // Convert links: [text](url) -> <url|text>
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>");

  // Convert headers: # text -> *text*
  result = result.replace(/^#{1,6}\s+(.+)$/gm, "*$1*");

  // Convert strikethrough: ~~text~~ -> ~text~
  result = result.replace(/~~([^~]+)~~/g, "~$1~");

  return result;
}

/**
 * Truncate text to Slack's message limit
 */
export function truncateForSlack(text: string, maxLength = 3000): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + "...";
}

/**
 * Split long text into multiple messages
 */
export function splitForSlack(text: string, maxLength = 3000): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Try to split at a newline
    let splitIndex = remaining.lastIndexOf("\n", maxLength);
    if (splitIndex === -1 || splitIndex < maxLength / 2) {
      // Try to split at a space
      splitIndex = remaining.lastIndexOf(" ", maxLength);
    }
    if (splitIndex === -1 || splitIndex < maxLength / 2) {
      // Force split
      splitIndex = maxLength;
    }

    chunks.push(remaining.slice(0, splitIndex));
    remaining = remaining.slice(splitIndex).trimStart();
  }

  return chunks;
}
