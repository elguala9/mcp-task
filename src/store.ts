import { promises as fs } from "node:fs";
import path from "node:path";
import { tasksDir, doneDir } from "./config.js";
import { TaskManagerError } from "./errors.js";

export const DONE_SUBDIR = "done";

function assertSafeRelativePath(relPath: string): void {
  const normalized = relPath.replace(/\\/g, "/");
  if (normalized.startsWith("/") || normalized.includes("..")) {
    throw new Error(`Invalid task path: "${relPath}"`);
  }
}

export function normalizeTaskPath(relPath: string): string {
  const normalized = relPath.replace(/\\/g, "/").replace(/^\.\/+/, "");
  assertSafeRelativePath(normalized);
  return normalized.endsWith(".md") ? normalized : `${normalized}.md`;
}

export function absolutePathFor(projectRoot: string, relPath: string): string {
  const normalized = normalizeTaskPath(relPath);
  return path.join(tasksDir(projectRoot), normalized);
}

export function isInDone(relPath: string): boolean {
  const normalized = normalizeTaskPath(relPath);
  return normalized === DONE_SUBDIR || normalized.startsWith(`${DONE_SUBDIR}/`);
}

export async function fileExists(absPath: string): Promise<boolean> {
  try {
    await fs.access(absPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Isolated collision guard reused wherever a task name must be unique across
 * the whole namespace: throws if `relPath` already exists either as an
 * active task (tasks/) or as an archived one (tasks/done/), regardless of
 * which of the two the caller is about to write to.
 */
export async function assertNoCollision(projectRoot: string, relPath: string): Promise<void> {
  const normalized = normalizeTaskPath(relPath);
  const bareRelPath = isInDone(normalized) ? normalized.slice(DONE_SUBDIR.length + 1) : normalized;
  const activeAbs = absolutePathFor(projectRoot, bareRelPath);
  const doneAbs = absolutePathFor(projectRoot, `${DONE_SUBDIR}/${bareRelPath}`);
  if ((await fileExists(activeAbs)) || (await fileExists(doneAbs))) {
    throw new TaskManagerError(
      "collision",
      `A task named "${bareRelPath}" already exists (checked tasks/ and tasks/done/). Choose a different name.`
    );
  }
}

/** Finds an existing task by relative path, checking both tasks/ and tasks/done/ placements. */
export async function findExistingTaskPath(projectRoot: string, relPath: string): Promise<string | null> {
  const abs = absolutePathFor(projectRoot, relPath);
  if (await fileExists(abs)) return normalizeTaskPath(relPath);
  return null;
}

async function walkMarkdownFiles(dir: string, base: string): Promise<string[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const results: string[] = [];
  for (const entry of entries) {
    if (entry.name === DONE_SUBDIR && base === "") continue; // done/ handled separately by caller
    const rel = base ? `${base}/${entry.name}` : entry.name;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await walkMarkdownFiles(abs, rel)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      results.push(rel);
    }
  }
  return results;
}

/** Lists active task relative paths (tasks/ only, excluding done/). */
export async function listActiveTaskPaths(projectRoot: string): Promise<string[]> {
  return walkMarkdownFiles(tasksDir(projectRoot), "");
}

/** Lists done task relative paths, prefixed with "done/". */
export async function listDoneTaskPaths(projectRoot: string): Promise<string[]> {
  const inner = await walkMarkdownFiles(doneDir(projectRoot), "");
  return inner.map((p) => `${DONE_SUBDIR}/${p}`);
}

export async function ensureDirFor(absFilePath: string): Promise<void> {
  await fs.mkdir(path.dirname(absFilePath), { recursive: true });
}
