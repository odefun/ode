import { WebClient } from "@slack/web-api";
import {
  getCronJobById,
  listCronJobs,
  type CronJobRecord,
} from "@/config/local/cron-jobs";

export const CRON_VIEW_DETAILS_ACTION = "cron_view_details";
export const CRON_RUN_NOW_ACTION = "cron_run_now";

function listCronJobsForChannel(channelId: string): CronJobRecord[] {
  return listCronJobs().filter((job) => job.channelId === channelId);
}

function formatTimestamp(value: number | null | undefined): string {
  if (!value || !Number.isFinite(value)) return "n/a";
  return new Date(value).toISOString();
}

function truncate(text: string, max: number): string {
  if (!text) return "";
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function statusEmoji(job: CronJobRecord): string {
  if (!job.enabled) return "⏸️";
  switch (job.lastRunStatus) {
    case "running":
      return "♻️";
    case "success":
      return "✅";
    case "failed":
      return "❌";
    case "idle":
    default:
      return "🕒";
  }
}

function buildJobRowBlocks(job: CronJobRecord): any[] {
  const title = truncate(job.title || "Cron job", 120);
  const summary = [
    `${statusEmoji(job)} *${title}*`,
    `\`${job.cronExpression}\` · ${job.enabled ? "enabled" : "disabled"} · last: ${job.lastRunStatus}`,
    truncate(job.messageText.split("\n")[0] ?? "", 140),
  ]
    .filter(Boolean)
    .join("\n");

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: summary,
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: CRON_VIEW_DETAILS_ACTION,
          text: { type: "plain_text", text: "View details" },
          value: job.id,
        },
        {
          type: "button",
          action_id: CRON_RUN_NOW_ACTION,
          text: { type: "plain_text", text: "Run now" },
          value: job.id,
          style: "primary",
        },
      ],
    },
    { type: "divider" },
  ];
}

export function buildCronJobsLauncherBlocks(
  channelId: string,
  jobs: CronJobRecord[]
): any[] {
  if (jobs.length === 0) {
    return [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `No cron jobs configured for this channel (\`${channelId}\`).\nCreate one with \`ode cron create --schedule "<cron>" --channel ${channelId} --message "..."\`.`,
        },
      },
    ];
  }

  const header: any[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Cron jobs for this channel* (${jobs.length})`,
      },
    },
    { type: "divider" },
  ];

  const rows: any[] = [];
  for (const job of jobs) {
    rows.push(...buildJobRowBlocks(job));
  }

  return [...header, ...rows];
}

export function buildCronJobDetailBlocks(job: CronJobRecord): any[] {
  const lines = [
    `*${job.title || "Cron job"}*`,
    `• *id:* \`${job.id}\``,
    `• *schedule:* \`${job.cronExpression}\``,
    `• *enabled:* ${job.enabled ? "yes" : "no"}`,
    `• *platform:* ${job.platform}`,
    `• *workspace:* ${job.workspaceName || job.workspaceId || "-"}`,
    `• *channel:* ${job.channelName || job.channelId} (\`${job.channelId}\`)`,
    `• *last status:* ${job.lastRunStatus}`,
    `• *last triggered:* ${formatTimestamp(job.lastTriggeredAt)}`,
    `• *last completed:* ${formatTimestamp(job.lastCompletedAt)}`,
    `• *created:* ${formatTimestamp(job.createdAt)}`,
    `• *updated:* ${formatTimestamp(job.updatedAt)}`,
  ];
  if (job.lastError) {
    lines.push(`• *last error:* \`${truncate(job.lastError, 400)}\``);
  }

  const blocks: any[] = [
    {
      type: "section",
      text: { type: "mrkdwn", text: lines.join("\n") },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Prompt:*\n\`\`\`${truncate(job.messageText, 2500)}\`\`\``,
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: CRON_RUN_NOW_ACTION,
          text: { type: "plain_text", text: "Run now" },
          value: job.id,
          style: "primary",
        },
      ],
    },
  ];

  return blocks;
}

export async function postSlackChannelCronLauncher(
  channelId: string,
  userId: string,
  client: WebClient
): Promise<void> {
  const jobs = listCronJobsForChannel(channelId);
  await client.chat.postEphemeral({
    channel: channelId,
    user: userId,
    text: jobs.length === 0 ? "No cron jobs for this channel." : "Cron jobs for this channel",
    blocks: buildCronJobsLauncherBlocks(channelId, jobs),
  });
}

export function getCronJobForChannel(
  channelId: string,
  jobId: string
): CronJobRecord | null {
  const job = getCronJobById(jobId);
  if (!job) return null;
  if (job.channelId !== channelId) return null;
  return job;
}
