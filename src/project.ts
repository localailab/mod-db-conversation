import { execFileSync } from "node:child_process";
import path from "node:path";

export type Project = {
  id: string; // hash of the repository's root commit: survives renames, moves, clones and remote changes
  name: string; // display name: the remote's repository name, else the folder name; may change
  root_path: string;
  git_remote: string | null; // normalized, e.g. github.com/foo/my-app
};

export function git(cwd: string, ...args: string[]): string | null {
  try {
    return (
      execFileSync("git", ["-C", cwd, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 256 * 1024 * 1024,
      }).trim() || null
    );
  } catch {
    return null;
  }
}

/**
 * git@github.com:foo/my-app.git / https://user@github.com/foo/my-app / ssh://git@github.com/foo/my-app.git
 *   → github.com/foo/my-app
 */
export function normalizeRemote(url: string): string {
  let s = url.trim().replace(/\/+$/, "").replace(/\.git$/, "");
  const scp = s.match(/^[^/@]+@([^:/]+):(.+)$/); // git@host:path
  if (scp) s = `${scp[1]}/${scp[2]}`;
  else s = s.replace(/^[a-z+]+:\/\//i, "").replace(/^[^/@]+@/, "").replace(/:\d+\//, "/");
  const [host, ...rest] = s.split("/");
  return [host!.toLowerCase(), ...rest].join("/");
}

export const NO_PROJECT =
  "conversation-memory works only inside a git repository with at least one commit; this directory has none";

const cache = new Map<string, Project | null>();

/**
 * Identify the project a directory belongs to, or null when it is not in a git
 * repository with commits (conversation-memory does not work there).
 */
export function resolveProject(cwd: string): Project | null {
  if (cache.has(cwd)) return cache.get(cwd)!;

  let project: Project | null = null;
  const root = git(cwd, "rev-parse", "--show-toplevel");
  // a history can have several roots (merged unrelated histories): the smallest hash is stable
  const rootCommit = root && git(cwd, "rev-list", "--max-parents=0", "HEAD")?.split("\n").sort()[0];
  if (root && rootCommit) {
    const remoteUrl = git(cwd, "remote", "get-url", "origin");
    const remote = remoteUrl ? normalizeRemote(remoteUrl) : null;
    project = {
      id: rootCommit,
      name: remote ? remote.split("/").pop()! : path.basename(root),
      root_path: root,
      git_remote: remote,
    };
  }
  cache.set(cwd, project);
  return project;
}
