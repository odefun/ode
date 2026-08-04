import type { ChannelComputerUseConfig } from "@/config";
import type { BrowserSnapshotState, DesktopSnapshotState } from "./types";

const CONSEQUENTIAL_LABEL = /\b(submit|send|post|publish|buy|purchase|pay|checkout|place order|order now|transfer|book|reserve|subscribe|unsubscribe|accept|agree|install|download|share|invite|deploy|merge|delete|remove|confirm|approve|allow|upload|sign[ -]?in|log[ -]?in|create account|save changes)\b/i;
const SENSITIVE_LABEL = /\b(password|passcode|one[- ]?time|otp|verification|credit card|card number|cvv|cvc|secret|token|api key|private key)\b/i;

export function assertAllowedOrigin(url: string, patterns: string[]): URL {
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`Browser navigation protocol is not allowed: ${parsed.protocol}`);
  }
  if (!patterns.some((pattern) => matchUrlPattern(parsed, pattern))) {
    throw new Error(`Browser origin is not allowed by this channel: ${parsed.origin}`);
  }
  return parsed;
}

function matchUrlPattern(url: URL, rawPattern: string): boolean {
  const pattern = rawPattern.trim();
  if (!pattern) return false;
  if (pattern === "*") return true;
  if (pattern.endsWith(":*") && url.origin === pattern.slice(0, -2)) return true;
  const candidate = `${url.origin}${url.pathname}`;
  const regex = new RegExp(`^${escapeRegex(pattern).replaceAll("\\*", ".*")}(?:/.*)?$`, "i");
  return regex.test(candidate) || regex.test(url.origin);
}

export function assertAllowedApp(app: string | undefined, patterns: string[]): string {
  const normalized = app?.trim();
  if (!normalized) {
    if (patterns.includes("*")) return "frontmost";
    throw new Error("desktop app is required unless allowedApps contains '*'");
  }
  if (!patterns.some((pattern) => globMatch(normalized, pattern))) {
    throw new Error(`Desktop application is not allowed by this channel: ${normalized}`);
  }
  return normalized;
}

export function browserActionNeedsApproval(
  input: Record<string, unknown>,
  snapshot: BrowserSnapshotState | undefined,
  policy: ChannelComputerUseConfig["approvalPolicy"],
): boolean {
  if (policy === "never") return false;
  if (policy === "always") return true;
  const action = String(input.action ?? "");
  if (["upload"].includes(action)) return true;
  if (action === "press" && /^(enter|return)$/i.test(String(input.key ?? ""))) return true;
  const label = browserTargetLabel(input.target, snapshot);
  if (action === "click" || action === "double_click") {
    const ref = browserTargetRef(input.target, snapshot);
    if (typeof input.target === "string" && input.target.startsWith("@") && !ref) return true;
    if (ref?.role === "button" && ![ref.name, ref.description].some((value) => typeof value === "string" && value.trim())) {
      return true;
    }
    return CONSEQUENTIAL_LABEL.test(label);
  }
  if (action === "fill" || action === "type") return SENSITIVE_LABEL.test(label);
  return false;
}

export function desktopActionNeedsApproval(
  input: Record<string, unknown>,
  snapshot: DesktopSnapshotState | undefined,
  policy: ChannelComputerUseConfig["approvalPolicy"],
): boolean {
  if (policy === "never") return false;
  if (policy === "always") return true;
  const action = String(input.action ?? "");
  if (action === "scroll") return false;
  if (action === "press" && !/^(enter|return)$/i.test(String(input.key ?? ""))) return false;
  const target = typeof input.target === "string" ? input.target : "";
  const element = snapshot?.elements[target];
  const label = [target, element?.label, element?.title, element?.description].filter(Boolean).join(" ");
  if (action === "click" || action === "double_click") {
    return true;
  }
  return true;
}

export function describeComputerAction(name: string, input: Record<string, unknown>): string {
  if (name === "browser_act") {
    return `browser ${String(input.action)}${input.target ? ` on ${String(input.target)}` : ""}`;
  }
  if (name === "desktop_act") {
    return `macOS ${String(input.action)}${input.app ? ` in ${String(input.app)}` : ""}${input.target ? ` on ${String(input.target)}` : ""}`;
  }
  return name;
}

function browserTargetLabel(target: unknown, snapshot: BrowserSnapshotState | undefined): string {
  const ref = browserTargetRef(target, snapshot);
  return [target, ref?.name, ref?.role, ref?.description].filter(Boolean).join(" ");
}

function browserTargetRef(target: unknown, snapshot: BrowserSnapshotState | undefined): Record<string, unknown> | undefined {
  if (typeof target !== "string") return undefined;
  const key = target.replace(/^@/, "");
  return snapshot?.refs[key];
}

function globMatch(value: string, pattern: string): boolean {
  if (pattern === "*") return true;
  return new RegExp(`^${escapeRegex(pattern).replaceAll("\\*", ".*")}$`, "i").test(value);
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.*]/g, "\\$&");
}
