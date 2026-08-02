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

  // Convert italic: *text* or _text_ -> _text_
  // Do this before converting bold so the freshly-created Slack `*bold*`
  // markers are not mistaken for CommonMark italics on the next line.
  result = result.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "_$1_");

  // Convert bold: **text** -> *text*
  result = result.replace(/\*\*([^*]+)\*\*/g, "*$1*");

  // Convert links: [text](url) -> <url|text>
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>");

  // Convert headers: # text -> *text*
  result = result.replace(/^#{1,6}\s+(.+)$/gm, "*$1*");

  // A leading `>` is Markdown blockquote syntax, not an arbitrary HTML
  // character. Restore it after the general Slack escaping above.
  result = result.replace(/^&gt;\s?/gm, "> ");

  // Convert strikethrough: ~~text~~ -> ~text~
  result = result.replace(/~~([^~]+)~~/g, "~$1~");

  return result;
}

/**
 * Truncate text to Slack's message limit
 */
export function truncateForSlack(text: string, maxLength = 3000, suffix = "..."): string {
  if (text.length <= maxLength) return text;
  const trimmedLength = Math.max(0, maxLength - suffix.length);
  return text.slice(0, trimmedLength) + suffix;
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
