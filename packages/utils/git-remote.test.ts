import { describe, expect, test } from "bun:test";
import { parseGitHubRemote } from "./git-remote";

describe("parseGitHubRemote", () => {
  test("returns null for empty/null/undefined", () => {
    expect(parseGitHubRemote(null)).toBeNull();
    expect(parseGitHubRemote(undefined)).toBeNull();
    expect(parseGitHubRemote("")).toBeNull();
    expect(parseGitHubRemote("   ")).toBeNull();
  });

  test("parses https url with .git suffix", () => {
    expect(parseGitHubRemote("https://github.com/anomalyco/ode.git")).toEqual({
      host: "github.com",
      owner: "anomalyco",
      repo: "ode",
    });
  });

  test("parses https url without .git suffix", () => {
    expect(parseGitHubRemote("https://github.com/anomalyco/ode")).toEqual({
      host: "github.com",
      owner: "anomalyco",
      repo: "ode",
    });
  });

  test("parses https url with trailing slash", () => {
    expect(parseGitHubRemote("https://github.com/anomalyco/ode/")).toEqual({
      host: "github.com",
      owner: "anomalyco",
      repo: "ode",
    });
  });

  test("parses scp-like git@ url", () => {
    expect(parseGitHubRemote("git@github.com:anomalyco/ode.git")).toEqual({
      host: "github.com",
      owner: "anomalyco",
      repo: "ode",
    });
  });

  test("parses ssh://git@ url", () => {
    expect(parseGitHubRemote("ssh://git@github.com/anomalyco/ode.git")).toEqual({
      host: "github.com",
      owner: "anomalyco",
      repo: "ode",
    });
  });

  test("parses git:// url", () => {
    expect(parseGitHubRemote("git://github.com/anomalyco/ode.git")).toEqual({
      host: "github.com",
      owner: "anomalyco",
      repo: "ode",
    });
  });

  test("parses https url with user info", () => {
    expect(parseGitHubRemote("https://user:token@github.com/anomalyco/ode.git")).toEqual({
      host: "github.com",
      owner: "anomalyco",
      repo: "ode",
    });
  });

  test("parses github enterprise hostnames", () => {
    expect(parseGitHubRemote("https://github.corp.example.com/team/proj.git")).toEqual({
      host: "github.corp.example.com",
      owner: "team",
      repo: "proj",
    });
    expect(parseGitHubRemote("git@github.enterprise.io:team/proj.git")).toEqual({
      host: "github.enterprise.io",
      owner: "team",
      repo: "proj",
    });
  });

  test("rejects non-github hosts", () => {
    expect(parseGitHubRemote("https://gitlab.com/foo/bar.git")).toBeNull();
    expect(parseGitHubRemote("git@bitbucket.org:foo/bar.git")).toBeNull();
    expect(parseGitHubRemote("https://codeberg.org/foo/bar")).toBeNull();
  });

  test("rejects look-alike hosts containing the substring 'github'", () => {
    expect(parseGitHubRemote("https://notgithub.com/foo/bar.git")).toBeNull();
    expect(parseGitHubRemote("git@evilgithub.org:foo/bar.git")).toBeNull();
    expect(parseGitHubRemote("https://github-mirror.example.com/foo/bar")).toBeNull();
  });

  test("accepts github.com subdomains", () => {
    expect(parseGitHubRemote("https://www.github.com/foo/bar.git")?.host).toBe("www.github.com");
    expect(parseGitHubRemote("git@ssh.github.com:foo/bar.git")?.host).toBe("ssh.github.com");
  });

  test("handles repo names with dots and dashes", () => {
    expect(parseGitHubRemote("https://github.com/foo/my-repo.js.git")).toEqual({
      host: "github.com",
      owner: "foo",
      repo: "my-repo.js",
    });
  });

  test("returns null for garbage input", () => {
    expect(parseGitHubRemote("not a url")).toBeNull();
    expect(parseGitHubRemote("https://github.com")).toBeNull();
    expect(parseGitHubRemote("https://github.com/onlyowner")).toBeNull();
  });
});
