import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";
import { log } from "./logger";

type WorktreeResult = {
  worktreePath: string;
  repoRoot: string | null;
  created: boolean;
  reused: boolean;
  skipped: boolean;
};

function runGit(args: string[], cwd: string, env?: Record<string, string>): string {
  const result = spawnSync("git", args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf-8",
  });

  if (result.status !== 0) {
    const stderr = String(result.stderr || "").trim();
    const stdout = String(result.stdout || "").trim();
    const detail = stderr || stdout || `git ${args.join(" ")}`;
    throw new Error(detail);
  }

  return String(result.stdout || "");
}

export function resolveRepoRoot(cwd: string, env?: Record<string, string>): string | null {
  try {
    const output = runGit(["rev-parse", "--show-toplevel"], cwd, env).trim();
    return output || null;
  } catch {
    return null;
  }
}

function listWorktrees(repoRoot: string, env?: Record<string, string>): string[] {
  const output = runGit(["worktree", "list", "--porcelain"], repoRoot, env);
  const lines = output.split(/\r?\n/);
  const paths: string[] = [];
  for (const line of lines) {
    if (line.startsWith("worktree ")) {
      const path = line.slice("worktree ".length).trim();
      if (path) paths.push(path);
    }
  }
  return paths;
}

function ensureDir(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
  }
}

function copyEnvFile(repoRoot: string, worktreePath: string): void {
  const source = join(repoRoot, ".env");
  if (!existsSync(source)) return;
  const target = join(worktreePath, ".env");
  if (existsSync(target)) return;
  copyFileSync(source, target);
}

function ensureWorktreeGitignore(repoRoot: string): void {
  const gitignorePath = join(repoRoot, ".gitignore");
  const entry = ".worktree/";
  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, `${entry}\n`);
    return;
  }

  const contents = readFileSync(gitignorePath, "utf-8");
  const pattern = /(^|\r?\n)\.worktree\/\s*(\r?\n|$)/;
  if (pattern.test(contents)) return;

  const suffix = contents.endsWith("\n") ? "" : "\n";
  writeFileSync(gitignorePath, `${contents}${suffix}${entry}\n`);
}

export async function ensureSessionWorktree(params: {
  cwd: string;
  sessionId: string;
  env?: Record<string, string>;
}): Promise<WorktreeResult> {
  const { cwd, sessionId, env } = params;
  const repoRoot = resolveRepoRoot(cwd, env);
  if (!repoRoot) {
    return { worktreePath: cwd, repoRoot: null, created: false, reused: false, skipped: true };
  }

  ensureWorktreeGitignore(repoRoot);

  const worktreeDir = join(repoRoot, ".worktree");
  const worktreePath = join(worktreeDir, sessionId);
  const existingWorktrees = listWorktrees(repoRoot, env);
  const hasRegistered = existingWorktrees.includes(worktreePath);
  const pathExists = existsSync(worktreePath);

  if (hasRegistered || pathExists) {
    if (!hasRegistered && pathExists) {
      log.warn("Worktree path exists but is not registered", { worktreePath });
    }
    copyEnvFile(repoRoot, worktreePath);
    return { worktreePath, repoRoot, created: false, reused: true, skipped: false };
  }

  ensureDir(worktreeDir);
  log.info("Pulling latest main before creating worktree", { repoRoot });
  runGit(["pull", "origin", "main"], repoRoot, env);

  log.info("Creating worktree for session", { worktreePath, sessionId });
  runGit(["worktree", "add", worktreePath, "main"], repoRoot, env);
  copyEnvFile(repoRoot, worktreePath);

  return { worktreePath, repoRoot, created: true, reused: false, skipped: false };
}
