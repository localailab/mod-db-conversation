// Which commit a message was written on top of: the newest commit of the message's
// branch that was committed at or before the message's time. Commits made in the
// middle of a turn therefore split the turn's messages correctly.
import { git } from "./project.js";

type Commit = { hash: string; time: number }; // time: committer date, seconds

const histories = new Map<string, Commit[]>();

function history(root: string, ref: string): Commit[] {
  const key = `${root}\0${ref}`;
  let list = histories.get(key);
  if (!list) {
    const log = git(root, "log", ref, "--format=%H %ct") ?? "";
    list = log
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [hash, ct] = line.split(" ");
        return { hash: hash!, time: Number(ct) };
      })
      .sort((a, b) => b.time - a.time); // newest first
    histories.set(key, list);
  }
  return list;
}

const refs = new Map<string, string>();

/** The branch if it still exists locally, else HEAD (deleted branch, detached HEAD). */
function refFor(root: string, branch: string | null): string {
  if (!branch || branch === "HEAD") return "HEAD";
  const key = `${root}\0${branch}`;
  let ref = refs.get(key);
  if (!ref) {
    ref = git(root, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`) ? `refs/heads/${branch}` : "HEAD";
    refs.set(key, ref);
  }
  return ref;
}

/** The commit the message at `timestamp` (ISO) on `branch` was based on, or null when none was yet. */
export function commitAt(root: string, branch: string | null, timestamp: string | null): string | null {
  const list = history(root, refFor(root, branch));
  if (!list.length) return null;
  if (!timestamp) return list[0]!.hash;
  const t = Date.parse(timestamp) / 1000;
  // binary search: first commit (newest first) with time <= t
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid]!.time <= t) hi = mid;
    else lo = mid + 1;
  }
  return list[lo]?.hash ?? null;
}
