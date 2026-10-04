// Where the memory lives, by storage mode (CONV_MEMORY_STORAGE):
//   shared (default): one DB for every project, separated by project id (~/.claude-memory/)
//   repo:             one DB per repository, in <repo>/.claude/conversation-memory/; a session
//                     reads and writes only the DB of the repository it was started in
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Project, git, resolveProject } from "./project.js";

export type Mode = "shared" | "repo";

export type Storage = {
  mode: Mode;
  db: string;
  vectors: string;
  /** repo mode: the repository that owns the DB; only its messages are saved and read */
  owner: Project | null;
};

const HOME_DIR = path.join(os.homedir(), ".claude-memory");
export const REPO_DIR = path.join(".claude", "conversation-memory");

export function storageMode(): Mode {
  const mode = process.env.CONV_MEMORY_STORAGE?.trim() || "shared";
  if (mode !== "shared" && mode !== "repo") {
    throw new Error(`unknown storage mode "${mode}" (CONV_MEMORY_STORAGE must be "shared" or "repo")`);
  }
  return mode;
}

/**
 * Resolve the storage for a session started in `dir`. In repo mode this also creates the
 * folder with a `.gitignore` of `*`, and refuses when git would still track the DB.
 */
export function resolveStorage(dir: string): Storage {
  const mode = storageMode();
  if (mode === "shared") {
    return {
      mode,
      db: process.env.CONV_MEMORY_DB ?? path.join(HOME_DIR, "conversations.db"),
      vectors: process.env.CONV_MEMORY_VECTORS ?? path.join(HOME_DIR, "vectors"),
      owner: null,
    };
  }

  const owner = resolveProject(dir);
  if (!owner) throw new Error(`not in a git repository with at least one commit: ${dir}`);
  const folder = path.join(owner.root_path, REPO_DIR);
  fs.mkdirSync(folder, { recursive: true });
  const ignore = path.join(folder, ".gitignore");
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, "# conversation-memory: never commit conversations\n*\n");

  const db = path.join(folder, "conversations.db");
  // check-ignore prints the path when ignored; null means git would track it
  if (!git(owner.root_path, "check-ignore", db)) {
    throw new Error(`not ignored by git, refusing to save conversations into the repository: ${db}`);
  }
  return { mode, db, vectors: path.join(folder, "vectors"), owner };
}
