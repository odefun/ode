#!/usr/bin/env bun

import packageJson from "../../package.json" with { type: "json" };
import { isInstalledBinary, performUpgrade } from "./upgrade";

const args = process.argv.slice(2);
const CURRENT_VERSION = packageJson.version ?? "0.0.0";

function printHelp(): void {
  // Keep this minimal; runtime.ts already handles --local/--cloud parsing.
  console.log(
    [
      "ode - OpenCode Slack bot",
      "",
      "Usage:",
      "  ode [--local|--cloud]",
      "  ode upgrade",
      "  ode --version",
      "",
      "Examples:",
      "  ode --local",
      "  ode --cloud",
      "  ode upgrade",
    ].join("\n")
  );
}

async function upgrade(): Promise<void> {
  if (!isInstalledBinary()) {
    console.error("ode upgrade must be run from the installed ode binary.");
    console.error("Install with: curl -fsSL https://raw.githubusercontent.com/odefun/ode/main/scripts/install.sh | bash");
    process.exit(1);
  }
  const { latestVersion } = await performUpgrade();
  if (latestVersion) {
    console.log(`ode upgraded (current version: ${latestVersion}).`);
    return;
  }

  console.log("ode upgraded.");
}

if (args.includes("--help") || args.includes("-h")) {
  printHelp();
  process.exit(0);
}

if (args.includes("--version") || args[0] === "version") {
  console.log(CURRENT_VERSION);
  process.exit(0);
}

if (args[0] === "upgrade") {
  await upgrade();
  process.exit(0);
}

await import("./index");
