import type { AttachmentSource } from "@/ims/shared/attachment-store";

export function parseLarkText(content: string | undefined): string {
  if (!content) return "";
  try {
    const parsed = JSON.parse(content) as unknown;
    if (typeof parsed === "string") return parsed;
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      if (typeof record.text === "string") return record.text;
      if (typeof record.content === "string") return record.content;
      const localized = (record.zh_cn ?? record.en_us) as Record<string, unknown> | undefined;
      const postBlocks = localized?.content;
      if (Array.isArray(postBlocks)) {
        const lines: string[] = [];
        for (const row of postBlocks) {
          if (!Array.isArray(row)) continue;
          const line = row
            .map((cell) => {
              if (!cell || typeof cell !== "object") return "";
              const textValue = (cell as Record<string, unknown>).text;
              return typeof textValue === "string" ? textValue : "";
            })
            .join("");
          if (line.trim()) lines.push(line);
        }
        if (lines.length > 0) return lines.join("\n");
      }
    }
    return content;
  } catch {
    return content;
  }
}

export function parseLarkAttachmentSources(params: {
  messageType: string;
  content: string | undefined;
  messageId: string;
  token: string;
}): AttachmentSource[] {
  if (!params.content) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(params.content);
  } catch {
    return [];
  }

  const candidates: Array<{ key: string; type: "image" | "file"; filename?: string }> = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    const filename = typeof record.file_name === "string" ? record.file_name : undefined;
    if (typeof record.file_key === "string" && record.file_key) {
      candidates.push({ key: record.file_key, type: "file", filename });
    }
    if (typeof record.image_key === "string" && record.image_key) {
      candidates.push({ key: record.image_key, type: "image", filename });
    }
    for (const child of Object.values(record)) visit(child);
  };
  visit(parsed);

  const directType = params.messageType === "image" ? "image" : "file";
  const seen = new Set<string>();
  return candidates.flatMap((candidate): AttachmentSource[] => {
    if (params.messageType !== "post" && candidate.type !== directType) return [];
    const resourceType = params.messageType === "post" ? candidate.type : directType;
    const dedupeKey = `${resourceType}:${candidate.key}`;
    if (seen.has(dedupeKey)) return [];
    seen.add(dedupeKey);
    const extension = resourceType === "image" ? ".png" : "";
    return [{
      id: candidate.key,
      filename: candidate.filename ?? `${candidate.key}${extension}`,
      url: `https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(params.messageId)}/resources/${encodeURIComponent(candidate.key)}?type=${resourceType}`,
      headers: { Authorization: `Bearer ${params.token}` },
    }];
  });
}
