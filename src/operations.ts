import { promises as fs } from "node:fs";
import path from "node:path";
import { loadConfig, tasksDir } from "./config.js";
import { slugify } from "./slug.js";
import { parseFrontmatter, serializeFile } from "./frontmatter.js";
import {
  toSectionTree,
  parseBody,
  resolveSectionPath,
  replaceSectionContent,
  appendToSectionContent,
  rawNodeToSectionNode,
} from "./sectionTree.js";
import { generateSectionsMarkdown } from "./sectionGen.js";
import {
  absolutePathFor,
  normalizeTaskPath,
  isInDone,
  fileExists,
  listActiveTaskPaths,
  listDoneTaskPaths,
  ensureDirFor,
  DONE_SUBDIR,
} from "./store.js";
import { RESERVED_STATUSES } from "./types.js";
import type {
  TaskConfig,
  TaskFrontmatter,
  TaskFull,
  TaskSummary,
  CheckIssue,
  CheckReport,
  SectionDef,
} from "./types.js";

export async function getConfig(projectRoot: string): Promise<TaskConfig> {
  return loadConfig(projectRoot);
}

async function readRawTask(projectRoot: string, relPath: string) {
  const normalized = normalizeTaskPath(relPath);
  const abs = absolutePathFor(projectRoot, normalized);
  let raw: string;
  try {
    raw = await fs.readFile(abs, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Task not found: "${normalized}"`);
    }
    throw err;
  }
  const { frontmatter, body } = parseFrontmatter(raw);
  return { relPath: normalized, abs, frontmatter, body };
}

async function writeRawTask(abs: string, frontmatter: TaskFrontmatter, body: string): Promise<void> {
  await ensureDirFor(abs);
  await fs.writeFile(abs, serializeFile(frontmatter, body), "utf8");
}

async function resolveDependencyLocation(projectRoot: string, depPath: string): Promise<string | null> {
  let normalized: string;
  try {
    normalized = normalizeTaskPath(depPath);
  } catch {
    return null;
  }
  if (await fileExists(absolutePathFor(projectRoot, normalized))) return normalized;
  const alt = isInDone(normalized) ? normalized.slice(DONE_SUBDIR.length + 1) : `${DONE_SUBDIR}/${normalized}`;
  if (await fileExists(absolutePathFor(projectRoot, alt))) return alt;
  return null;
}

function toSummary(relPath: string, fm: TaskFrontmatter): TaskSummary {
  return {
    path: relPath,
    title: String(fm.title ?? ""),
    status: String(fm.status ?? ""),
    priority: fm.priority ? String(fm.priority) : undefined,
    type: String(fm.type ?? ""),
  };
}

// ---------------------------------------------------------------------------
// create_task
// ---------------------------------------------------------------------------

export interface CreateTaskInput {
  title: string;
  type: string;
  priority?: string;
  status?: string;
  dependencies?: string[];
}

export async function createTask(projectRoot: string, input: CreateTaskInput): Promise<TaskSummary> {
  const config = await getConfig(projectRoot);
  const { title, type } = input;
  if (!title || !title.trim()) throw new Error("title is required");
  if (!type || !type.trim()) throw new Error("type is required");

  const slug = slugify(title);
  if (!slug) throw new Error(`Could not derive a filename slug from title "${title}"`);
  const relPath = `${slug}.md`;

  const activeAbs = absolutePathFor(projectRoot, relPath);
  const doneAbs = absolutePathFor(projectRoot, `${DONE_SUBDIR}/${relPath}`);
  if ((await fileExists(activeAbs)) || (await fileExists(doneAbs))) {
    throw new Error(
      `A task named "${relPath}" already exists. Choose a different title to avoid a filename collision.`
    );
  }

  const status = input.status ?? "created";
  if (!config.statuses.includes(status)) {
    throw new Error(`Unknown status "${status}". Defined statuses: ${config.statuses.join(", ")}`);
  }

  let priority: string | undefined = input.priority;
  if (priority !== undefined && config.priorities.length > 0 && !config.priorities.includes(priority)) {
    throw new Error(`Unknown priority "${priority}". Defined priorities: ${config.priorities.join(", ")}`);
  }
  if (priority === undefined && config.priorities.length > 0) {
    priority = config.priorities[0];
  }

  const dependencies = input.dependencies ?? [];
  for (const dep of dependencies) {
    const resolved = await resolveDependencyLocation(projectRoot, dep);
    if (!resolved) {
      throw new Error(`Dependency "${dep}" does not point to an existing task (checked tasks/ and tasks/done/).`);
    }
  }

  const typeDef = config.types[type];
  const body = generateSectionsMarkdown(typeDef?.sections, 2);

  const now = new Date().toISOString();
  const frontmatter: TaskFrontmatter = {
    title,
    type,
    status,
    created_at: now,
    updated_at: now,
  };
  if (priority !== undefined) frontmatter.priority = priority;
  if (dependencies.length > 0) frontmatter.dependencies = dependencies;

  await writeRawTask(activeAbs, frontmatter, body);
  return toSummary(relPath, frontmatter);
}

// ---------------------------------------------------------------------------
// list_tasks
// ---------------------------------------------------------------------------

export interface ListTasksFilters {
  status?: string;
  type?: string;
  priority?: string;
  tag?: string;
  include_done?: boolean;
}

export async function listTasks(projectRoot: string, filters: ListTasksFilters = {}): Promise<TaskSummary[]> {
  const includeDone = filters.include_done ?? false;
  const relPaths = [
    ...(await listActiveTaskPaths(projectRoot)),
    ...(includeDone ? await listDoneTaskPaths(projectRoot) : []),
  ];

  const results: TaskSummary[] = [];
  for (const relPath of relPaths) {
    const abs = absolutePathFor(projectRoot, relPath);
    const raw = await fs.readFile(abs, "utf8");
    const { frontmatter } = parseFrontmatter(raw);
    if (filters.status && frontmatter.status !== filters.status) continue;
    if (filters.type && frontmatter.type !== filters.type) continue;
    if (filters.priority && frontmatter.priority !== filters.priority) continue;
    if (filters.tag && !(frontmatter.tags ?? []).includes(filters.tag)) continue;
    results.push(toSummary(relPath, frontmatter));
  }
  return results;
}

// ---------------------------------------------------------------------------
// get_task / get_section
// ---------------------------------------------------------------------------

export async function getTask(projectRoot: string, relPath: string): Promise<TaskFull> {
  const { relPath: normalized, frontmatter, body } = await readRawTask(projectRoot, relPath);
  return { path: normalized, frontmatter, sections: toSectionTree(body) };
}

export async function getSection(projectRoot: string, relPath: string, sectionPath: string) {
  const { body } = await readRawTask(projectRoot, relPath);
  const parsed = parseBody(body);
  const { node } = resolveSectionPath(parsed, sectionPath);
  return rawNodeToSectionNode(node, parsed.lines);
}

// ---------------------------------------------------------------------------
// get_task_description
// ---------------------------------------------------------------------------

function findSectionDefByPath(sections: SectionDef[] | undefined, sectionPath: string): SectionDef | null {
  const segments = sectionPath
    .split(">")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (segments.length === 0 || !sections) return null;

  // exact chain match from root
  let candidates = sections;
  let matched: SectionDef | undefined;
  let exactOk = true;
  for (const segment of segments) {
    matched = candidates.find((s) => s.name === segment);
    if (!matched) {
      exactOk = false;
      break;
    }
    candidates = matched.sections ?? [];
  }
  if (exactOk && matched) return matched;

  // fallback: section names are unique within a type (enforced at config load time),
  // so a search by the path's last segment name is unambiguous.
  const target = segments[segments.length - 1];
  let found: SectionDef | null = null;
  const walk = (nodes: SectionDef[]) => {
    for (const node of nodes) {
      if (node.name === target) found = node;
      if (node.sections) walk(node.sections);
    }
  };
  walk(sections);
  return found;
}

export async function getTaskDescription(
  projectRoot: string,
  type: string,
  sectionPath: string
): Promise<{ type: string; section: string; description: string | null }> {
  const config = await getConfig(projectRoot);
  const typeDef = config.types[type];
  const def = findSectionDefByPath(typeDef?.sections, sectionPath);
  if (!def) {
    throw new Error(`Section "${sectionPath}" is not defined for type "${type}" in task-config.yaml`);
  }
  return { type, section: sectionPath, description: def.description ?? null };
}

// ---------------------------------------------------------------------------
// check_task / fix_task
// ---------------------------------------------------------------------------

function collectHeadingDuplicates(nodes: ReturnType<typeof toSectionTree>, seen: Map<string, number>): string[] {
  const dups: string[] = [];
  for (const node of nodes) {
    if (node.kind === "heading") {
      seen.set(node.name, (seen.get(node.name) ?? 0) + 1);
      if ((seen.get(node.name) ?? 0) === 2) dups.push(node.name);
    }
    dups.push(...collectHeadingDuplicates(node.children, seen));
  }
  return dups;
}

function findMissingSections(
  expected: SectionDef[] | undefined,
  actual: ReturnType<typeof toSectionTree>,
  prefix: string
): CheckIssue[] {
  if (!expected || expected.length === 0) return [];
  const issues: CheckIssue[] = [];
  const actualHeadings = actual.filter((n) => n.kind === "heading");
  for (const def of expected) {
    const fullPath = prefix ? `${prefix} > ${def.name}` : def.name;
    const match = actualHeadings.find((n) => n.name === def.name);
    if (!match) {
      issues.push({ type: "missing_section", message: `Missing section "${fullPath}"`, path: fullPath });
      continue;
    }
    issues.push(...findMissingSections(def.sections, match.children, fullPath));
  }
  return issues;
}

export async function checkTask(projectRoot: string, relPath: string): Promise<CheckReport> {
  const config = await getConfig(projectRoot);
  const { relPath: normalized, frontmatter, body } = await readRawTask(projectRoot, relPath);
  const sections = toSectionTree(body);
  const issues: CheckIssue[] = [];

  if (frontmatter.status !== undefined && !config.statuses.includes(String(frontmatter.status))) {
    issues.push({ type: "unrecognized_status", message: `Unrecognized status "${frontmatter.status}"` });
  }
  if (frontmatter.priority !== undefined && !config.priorities.includes(String(frontmatter.priority))) {
    issues.push({ type: "unrecognized_priority", message: `Unrecognized priority "${frontmatter.priority}"` });
  }

  const typeDef = config.types[String(frontmatter.type)];
  issues.push(...findMissingSections(typeDef?.sections, sections, ""));

  const dupNames = collectHeadingDuplicates(sections, new Map());
  for (const name of dupNames) {
    issues.push({ type: "duplicate_section", message: `Duplicate section name "${name}"`, path: name });
  }

  for (const dep of frontmatter.dependencies ?? []) {
    const resolved = await resolveDependencyLocation(projectRoot, dep);
    if (!resolved) {
      issues.push({ type: "broken_dependency", message: `Dependency "${dep}" does not exist`, path: dep });
    }
  }

  return { path: normalized, ok: issues.length === 0, issues };
}

const ADDITIVE_FIXABLE = new Set<CheckIssue["type"]>(["missing_section"]);

export interface FixTaskResult {
  path: string;
  fixed: boolean;
  message: string;
  remainingIssues: CheckIssue[];
}

interface Insertion {
  atLine: number;
  text: string;
}

function computeMissingInsertions(
  expected: SectionDef[] | undefined,
  actualNodes: ReturnType<typeof parseBody>["roots"],
  parentEndLine: number,
  level: number,
  insertions: Insertion[]
): void {
  if (!expected || expected.length === 0) return;
  const actualHeadings = actualNodes.filter((n) => n.kind === "heading");
  for (const def of expected) {
    const match = actualHeadings.find((n) => n.name === def.name);
    if (!match) {
      const block = generateSectionsMarkdown([def], level);
      insertions.push({ atLine: parentEndLine, text: block });
    } else {
      computeMissingInsertions(def.sections, match.children, match.contentEnd, level + 1, insertions);
    }
  }
}

export async function fixTask(projectRoot: string, relPath: string): Promise<FixTaskResult> {
  const report = await checkTask(projectRoot, relPath);
  const unfixable = report.issues.filter((i) => !ADDITIVE_FIXABLE.has(i.type));
  if (unfixable.length > 0) {
    return {
      path: report.path,
      fixed: false,
      message: `Cannot auto-fix: found issue(s) that require manual intervention: ${unfixable
        .map((i) => i.message)
        .join("; ")}`,
      remainingIssues: report.issues,
    };
  }
  const missing = report.issues.filter((i) => i.type === "missing_section");
  if (missing.length === 0) {
    return { path: report.path, fixed: true, message: "Nothing to fix.", remainingIssues: [] };
  }

  const config = await getConfig(projectRoot);
  const { abs, frontmatter, body } = await readRawTask(projectRoot, relPath);
  const parsed = parseBody(body);
  const typeDef = config.types[String(frontmatter.type)];

  const insertions: Insertion[] = [];
  computeMissingInsertions(typeDef?.sections, parsed.roots, parsed.lines.length, 2, insertions);
  insertions.sort((a, b) => b.atLine - a.atLine);

  let lines = [...parsed.lines];
  for (const ins of insertions) {
    const block = ins.text.split("\n");
    const needsLeadingBlank = lines[ins.atLine - 1] !== undefined && lines[ins.atLine - 1].trim() !== "";
    const toInsert = needsLeadingBlank ? ["", ...block] : block;
    lines.splice(ins.atLine, 0, ...toInsert);
  }
  const newBody = lines.join("\n");
  await writeRawTask(abs, frontmatter, newBody);

  return {
    path: report.path,
    fixed: true,
    message: `Added ${missing.length} missing section(s).`,
    remainingIssues: [],
  };
}

// ---------------------------------------------------------------------------
// update_task / update_section / append_to_section
// ---------------------------------------------------------------------------

export interface SectionUpdate {
  path: string;
  content: string;
}

export interface UpdateTaskInput {
  frontmatter?: Partial<Omit<TaskFrontmatter, "type">> & { type?: never };
  sections?: SectionUpdate[];
}

async function relocateIfNeeded(
  projectRoot: string,
  relPath: string,
  oldStatus: string | undefined,
  newStatus: string | undefined
): Promise<string> {
  if (newStatus === undefined || newStatus === oldStatus) return relPath;
  const currentlyInDone = isInDone(relPath);

  if (newStatus === "finished" && !currentlyInDone) {
    const target = `${DONE_SUBDIR}/${relPath}`;
    const targetAbs = absolutePathFor(projectRoot, target);
    if (await fileExists(targetAbs)) {
      throw new Error(`Cannot move task to tasks/done/: "${target}" already exists there.`);
    }
    await ensureDirFor(targetAbs);
    await fs.rename(absolutePathFor(projectRoot, relPath), targetAbs);
    return target;
  }

  if (oldStatus === "finished" && newStatus !== "finished" && currentlyInDone) {
    const target = relPath.slice(DONE_SUBDIR.length + 1);
    const targetAbs = absolutePathFor(projectRoot, target);
    if (await fileExists(targetAbs)) {
      throw new Error(`Cannot move task out of tasks/done/: "${target}" already exists there.`);
    }
    await ensureDirFor(targetAbs);
    await fs.rename(absolutePathFor(projectRoot, relPath), targetAbs);
    return target;
  }

  return relPath;
}

export async function updateTask(projectRoot: string, relPath: string, input: UpdateTaskInput): Promise<TaskFull> {
  if (input.frontmatter && "type" in input.frontmatter && input.frontmatter.type !== undefined) {
    throw new Error('The "type" field cannot be changed via update_task.');
  }

  const config = await getConfig(projectRoot);
  const current = await readRawTask(projectRoot, relPath);
  const oldStatus = current.frontmatter.status;

  const providedFrontmatter = Object.fromEntries(
    Object.entries(input.frontmatter ?? {}).filter(([, v]) => v !== undefined)
  );
  const mergedFrontmatter: TaskFrontmatter = { ...current.frontmatter, ...providedFrontmatter };

  if (input.frontmatter?.status !== undefined && !config.statuses.includes(String(mergedFrontmatter.status))) {
    throw new Error(
      `Unknown status "${mergedFrontmatter.status}". Defined statuses: ${config.statuses.join(", ")}`
    );
  }
  if (
    input.frontmatter?.priority !== undefined &&
    config.priorities.length > 0 &&
    !config.priorities.includes(String(mergedFrontmatter.priority))
  ) {
    throw new Error(
      `Unknown priority "${mergedFrontmatter.priority}". Defined priorities: ${config.priorities.join(", ")}`
    );
  }

  mergedFrontmatter.updated_at = new Date().toISOString();

  let body = current.body;
  for (const section of input.sections ?? []) {
    body = replaceSectionContent(body, section.path, section.content);
  }

  const newRelPath = await relocateIfNeeded(projectRoot, current.relPath, String(oldStatus), mergedFrontmatter.status);
  const newAbs = absolutePathFor(projectRoot, newRelPath);
  await writeRawTask(newAbs, mergedFrontmatter, body);

  return { path: newRelPath, frontmatter: mergedFrontmatter, sections: toSectionTree(body) };
}

export async function updateSection(
  projectRoot: string,
  relPath: string,
  sectionPath: string,
  content: string
): Promise<TaskFull> {
  const current = await readRawTask(projectRoot, relPath);
  const newBody = replaceSectionContent(current.body, sectionPath, content);
  const frontmatter = { ...current.frontmatter, updated_at: new Date().toISOString() };
  await writeRawTask(current.abs, frontmatter, newBody);
  return { path: current.relPath, frontmatter, sections: toSectionTree(newBody) };
}

export async function appendToSection(
  projectRoot: string,
  relPath: string,
  sectionPath: string,
  content: string
): Promise<TaskFull> {
  const current = await readRawTask(projectRoot, relPath);
  const newBody = appendToSectionContent(current.body, sectionPath, content);
  const frontmatter = { ...current.frontmatter, updated_at: new Date().toISOString() };
  await writeRawTask(current.abs, frontmatter, newBody);
  return { path: current.relPath, frontmatter, sections: toSectionTree(newBody) };
}

// ---------------------------------------------------------------------------
// delete_task
// ---------------------------------------------------------------------------

export async function deleteTask(projectRoot: string, relPath: string): Promise<void> {
  const { abs, relPath: normalized } = await readRawTask(projectRoot, relPath);
  await fs.unlink(abs);
  void normalized;
}

// ---------------------------------------------------------------------------
// move_task
// ---------------------------------------------------------------------------

export async function moveTask(projectRoot: string, fromPath: string, toPath: string): Promise<TaskSummary> {
  const current = await readRawTask(projectRoot, fromPath);
  const targetRelPath = normalizeTaskPath(toPath);

  if (targetRelPath === current.relPath) {
    throw new Error(`Source and destination are the same: "${targetRelPath}"`);
  }
  if (await fileExists(absolutePathFor(projectRoot, targetRelPath))) {
    throw new Error(`A task already exists at "${targetRelPath}". Choose a different destination path.`);
  }

  const targetAbs = absolutePathFor(projectRoot, targetRelPath);
  await ensureDirFor(targetAbs);
  await fs.rename(current.abs, targetAbs);

  return toSummary(targetRelPath, current.frontmatter);
}

// ---------------------------------------------------------------------------
// get_next_task
// ---------------------------------------------------------------------------

export async function getNextTask(projectRoot: string): Promise<TaskSummary | null> {
  const config = await getConfig(projectRoot);
  const activePaths = await listActiveTaskPaths(projectRoot);

  const candidates: { relPath: string; fm: TaskFrontmatter }[] = [];
  for (const relPath of activePaths) {
    const abs = absolutePathFor(projectRoot, relPath);
    const raw = await fs.readFile(abs, "utf8");
    const { frontmatter } = parseFrontmatter(raw);
    if (frontmatter.status !== "created") continue;

    let allSatisfied = true;
    for (const dep of frontmatter.dependencies ?? []) {
      const resolved = await resolveDependencyLocation(projectRoot, dep);
      if (!resolved) {
        allSatisfied = false;
        break;
      }
      const depRaw = await fs.readFile(absolutePathFor(projectRoot, resolved), "utf8");
      const { frontmatter: depFm } = parseFrontmatter(depRaw);
      if (depFm.status !== "finished") {
        allSatisfied = false;
        break;
      }
    }
    if (!allSatisfied) continue;
    candidates.push({ relPath, fm: frontmatter });
  }

  if (candidates.length === 0) return null;

  const priorityRank = (p: unknown) => {
    const idx = config.priorities.indexOf(String(p));
    return idx === -1 ? -1 : idx;
  };

  candidates.sort((a, b) => {
    const rankDiff = priorityRank(b.fm.priority) - priorityRank(a.fm.priority);
    if (rankDiff !== 0) return rankDiff;
    const aTime = new Date(String(a.fm.created_at)).getTime();
    const bTime = new Date(String(b.fm.created_at)).getTime();
    return aTime - bTime;
  });

  const winner = candidates[0];
  return toSummary(winner.relPath, winner.fm);
}

// ---------------------------------------------------------------------------
// status shortcuts
// ---------------------------------------------------------------------------

export async function startTask(projectRoot: string, relPath: string): Promise<TaskFull> {
  return updateTask(projectRoot, relPath, { frontmatter: { status: "started" } });
}

export async function testTask(projectRoot: string, relPath: string): Promise<TaskFull> {
  return updateTask(projectRoot, relPath, { frontmatter: { status: "tested" } });
}

export async function deployTask(projectRoot: string, relPath: string): Promise<TaskFull> {
  return updateTask(projectRoot, relPath, { frontmatter: { status: "deployed" } });
}

export async function endTask(projectRoot: string, relPath: string): Promise<TaskFull> {
  return updateTask(projectRoot, relPath, { frontmatter: { status: "finished" } });
}

export async function changeStatus(projectRoot: string, relPath: string, status: string): Promise<TaskFull> {
  return updateTask(projectRoot, relPath, { frontmatter: { status } });
}

export { RESERVED_STATUSES };
export { tasksDir };
