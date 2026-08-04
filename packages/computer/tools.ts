import { z } from "zod";
import type { ComputerToolName } from "./types";

type ToolDefinition = {
  name: ComputerToolName;
  description: string;
  shape: Record<string, z.ZodTypeAny>;
};

export const COMPUTER_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "computer_session",
    description: "Inspect or close the current Ode Computer Gateway browser/desktop session. Use status before deciding which surface is available.",
    shape: {
      action: z.enum(["status", "close"]).default("status"),
      surface: z.enum(["all", "browser", "desktop"]).default("all"),
    },
  },
  {
    name: "browser_navigate",
    description: "Navigate the isolated local browser to an allowed URL. Call browser_observe afterwards to obtain a fresh revision and element refs.",
    shape: {
      url: z.string().url(),
    },
  },
  {
    name: "browser_observe",
    description: "Read the browser accessibility snapshot and fresh element refs. The returned revision is required by browser_act and becomes stale after any mutation.",
    shape: {
      interactive: z.boolean().default(true),
      includeUrls: z.boolean().default(true),
      screenshot: z.boolean().default(false),
      fullPage: z.boolean().default(false),
    },
  },
  {
    name: "browser_act",
    description: "Act on a browser element from the latest browser_observe result. Always pass that result's revision; observe again after the action.",
    shape: {
      revision: z.string().min(1),
      action: z.enum(["click", "double_click", "fill", "type", "press", "select", "hover", "scroll", "upload"]),
      target: z.string().optional(),
      value: z.string().optional(),
      values: z.array(z.string()).optional(),
      key: z.string().optional(),
      direction: z.enum(["up", "down", "left", "right"]).optional(),
      amount: z.number().int().min(1).max(10_000).optional(),
      paths: z.array(z.string()).optional(),
    },
  },
  {
    name: "browser_inspect",
    description: "Inspect a browser property without mutating the page. Element actions require a target ref or selector; page title and URL do not.",
    shape: {
      property: z.enum(["text", "html", "attribute", "value", "title", "url", "count"]),
      target: z.string().optional(),
      attribute: z.string().optional(),
    },
  },
  {
    name: "desktop_observe",
    description: "Capture and inspect an allowed macOS application through Ode. The returned revision and snapshot_id are required by desktop_act.",
    shape: {
      app: z.string().optional(),
      annotate: z.boolean().default(true),
      screenshot: z.boolean().default(true),
    },
  },
  {
    name: "desktop_act",
    description: "Control an allowed macOS application using the latest desktop_observe snapshot. Always pass the fresh revision; observe again after acting.",
    shape: {
      revision: z.string().min(1),
      action: z.enum(["click", "double_click", "type", "press", "hotkey", "scroll", "launch_app", "open_url"]),
      app: z.string().optional(),
      target: z.string().optional(),
      value: z.string().optional(),
      key: z.string().optional(),
      keys: z.array(z.string()).optional(),
      direction: z.enum(["up", "down", "left", "right"]).optional(),
      amount: z.number().int().min(1).max(100).optional(),
      url: z.string().url().optional(),
    },
  },
  {
    name: "computer_wait",
    description: "Wait for a browser condition or for a short bounded time. Prefer text, URL, or load conditions over fixed delays.",
    shape: {
      surface: z.enum(["browser", "desktop"]).default("browser"),
      condition: z.enum(["time", "text", "url", "load"]).default("time"),
      value: z.string().optional(),
      timeoutMs: z.number().int().min(1).max(60_000).default(10_000),
    },
  },
];

const definitionByName = new Map(COMPUTER_TOOL_DEFINITIONS.map((definition) => [definition.name, definition]));

export function getComputerToolDefinition(name: string): ToolDefinition | undefined {
  return definitionByName.get(name as ComputerToolName);
}

export function parseComputerToolInput(name: string, input: unknown): Record<string, unknown> {
  const definition = getComputerToolDefinition(name);
  if (!definition) throw new Error(`Unknown Ode Computer tool: ${name}`);
  return z.object(definition.shape).parse(input ?? {}) as Record<string, unknown>;
}

export function getComputerDynamicToolSpecs(): Array<{
  name: ComputerToolName;
  description: string;
  inputSchema: Record<string, unknown>;
  deferLoading: boolean;
}> {
  return COMPUTER_TOOL_DEFINITIONS.map((definition) => {
    const jsonSchema = z.toJSONSchema(z.object(definition.shape)) as Record<string, unknown>;
    delete jsonSchema.$schema;
    return {
      name: definition.name,
      description: definition.description,
      inputSchema: jsonSchema,
      deferLoading: false,
    };
  });
}
