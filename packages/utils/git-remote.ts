import { spawnSync } from "child_process";

export type GitHubRepo = {
  owner: string;
  repo: string;
  host: string; // e.g. "github.com" or "github.enterprise.com"
};

/**
 * Return true iff `host` is a legitimate GitHub hostname. We accept the
 * canonical public host, explicit subdomains of `github.com`, and anything
 * whose hostname literally starts with `github.` (typical GHES convention
 * for per-tenant subdomains like `github.corp.example.com`). We reject
 * look-alike domains such as `notgithub.com` that contain the substring
 * "github" but are not actually run by GitHub.
 */
function isGitHubHost(host: string): boolean {
  const lowered = host.trim().toLowerCase();
  if (!lowered) return false;
  if (lowered === "github.com" || lowered === "www.github.com") return true;
  if (lowered.endsWith(".github.com")) return true; // ssh.github.com, gist.github.com, ...
  if (lowered.startsWith("github.")) return true; // github.corp.example.com (GHES)
  return false;
}

/**
 * Parse a git remote URL and return the GitHub owner / repo.
 * Supports the common GitHub URL shapes:
 *   - https://github.com/owner/repo.git
 *   - https://github.com/owner/repo
 *   - http://github.com/owner/repo.git
 *   - git@github.com:owner/repo.git
 *   - ssh://git@github.com/owner/repo.git
 *   - git://github.com/owner/repo.git
 *
 * Returns null for non-GitHub hosts or unparseable URLs.
 */
export function parseGitHubRemote(url: string | null | undefined): GitHubRepo | null {
  if (!url) return null;
  const trimmed = url.trim();
  if (!trimmed) return null;

  // scp-like syntax: git@host:owner/repo(.git)
  const scpMatch = trimmed.match(/^[\w.-]+@([\w.-]+):([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  if (scpMatch) {
    const host = scpMatch[1]!;
    const owner = scpMatch[2]!;
    const repo = scpMatch[3]!;
    if (!isGitHubHost(host)) return null;
    return { host, owner, repo };
  }

  // URL-like syntax: scheme://[user@]host[:port]/owner/repo(.git)
  const urlMatch = trimmed.match(
    /^(?:[a-zA-Z][a-zA-Z0-9+.-]*:\/\/)?(?:[^@/]+@)?([\w.-]+)(?::\d+)?\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/,
  );
  if (urlMatch) {
    const host = urlMatch[1]!;
    const owner = urlMatch[2]!;
    const repo = urlMatch[3]!;
    if (!isGitHubHost(host)) return null;
    return { host, owner, repo };
  }

  return null;
}

/**
 * Read the configured origin remote URL from a working directory.
 * Returns null if not a git repo, no remote, or git fails.
 */
export function readRemoteUrl(cwd: string, remoteName: string = "origin"): string | null {
  const result = spawnSync("git", ["config", "--get", `remote.${remoteName}.url`], {
    cwd,
    encoding: "utf-8",
  });
  if (result.status !== 0) return null;
  const out = String(result.stdout || "").trim();
  return out || null;
}

/**
 * Resolve the GitHub owner/repo for a given working directory.
 *
 * Tries `origin` first. Returns null if the directory is not inside a git repo,
 * has no origin remote, or the remote isn't a GitHub URL.
 */
export function getGitHubRepoFromCwd(cwd: string): GitHubRepo | null {
  const url = readRemoteUrl(cwd, "origin");
  return parseGitHubRemote(url);
}
