import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { validateConfig, tasksDir, initConfig as initConfigFile } from "./config.js";
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
  assertNoCollision,
  DONE_SUBDIR,
} from "./store.js";
import { RESERVED_STATUSES } from "./types.js";
import { TaskManagerError } from "./errors.js";
import type {
  TaskConfig,
  TaskFrontmatter,
  TaskFull,
  TaskSummary,
  CheckIssue,
  CheckReport,
  SectionDef,
} from "./types.js";

/**
 * Loads and validates task-config.yaml. Every exported operation below calls
 * this (directly or through a helper that already does) before touching any
 * task file, so a broken config is always caught up front, not only by the
 * commands that happen to read the fields that are wrong.
 */
export async function getConfig(projectRoot: string): Promise<TaskConfig> {
  return validateConfig(projectRoot);
}

/** Alias exposed to CLI/MCP under the tool name `get_task_config`. */
export const getTaskConfig = getConfig;

/** Creates task-config.yaml from the packaged example, if it doesn't already exist. */
export async function initConfig(projectRoot: string, options: { force?: boolean } = {}): Promise<{ path: string }> {
  return initConfigFile(projectRoot, options);
}

async function readRawTask(projectRoot: string, relPath: string) {
  const normalized = normalizeTaskPath(relPath);
  const abs = absolutePathFor(projectRoot, normalized);
  let raw: string;
  try {
    raw = await fs.readFile(abs, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new TaskManagerError("not_found", `Task not found: "${normalized}"`);
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

/**
 * Reads the `group` of every linked task that can be resolved, keyed by its
 * resolved path. Links that don't resolve (broken dependency/based_on) or
 * that resolve to a task with no group set are omitted, since an unset group
 * never conflicts with anything.
 */
async function resolveLinkedGroups(projectRoot: string, links: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const link of links) {
    const resolved = await resolveDependencyLocation(projectRoot, link);
    if (!resolved) continue;
    const raw = await fs.readFile(absolutePathFor(projectRoot, resolved), "utf8");
    const { frontmatter } = parseFrontmatter(raw);
    const group = frontmatter.group;
    if (group !== undefined && group !== null && String(group).trim().length > 0) {
      map.set(resolved, String(group));
    }
  }
  return map;
}

/**
 * Enforces the group invariant: two tasks joined by a dependency/based_on
 * link can never carry different (both-defined) group values. `linkedGroups`
 * is the resolved group of each of this task's own links (see
 * resolveLinkedGroups). Returns the group the task should end up with: an
 * explicit `ownGroup` wins when compatible; otherwise a single group shared
 * by all links is inherited automatically, so a task doesn't need `group`
 * set manually just because everything it points at agrees on one.
 */
function reconcileGroup(ownGroup: string | undefined, linkedGroups: Map<string, string>): string | undefined {
  const distinct = new Set(linkedGroups.values());
  if (distinct.size > 1) {
    const detail = [...linkedGroups.entries()].map(([p, g]) => `${p} (group "${g}")`).join(", ");
    throw new TaskManagerError(
      "group_conflict",
      `Cannot reconcile group: linked tasks already belong to different groups: ${detail}`
    );
  }
  const inherited = distinct.size === 1 ? [...distinct][0] : undefined;
  if (inherited !== undefined && ownGroup !== undefined && ownGroup !== inherited) {
    const detail = [...linkedGroups.entries()].map(([p, g]) => `${p} (group "${g}")`).join(", ");
    throw new TaskManagerError(
      "group_conflict",
      `group "${ownGroup}" conflicts with the group of linked task(s): ${detail}`
    );
  }
  return ownGroup ?? inherited;
}

/** Every other task (active or done) whose dependencies/based_on reference `targetPath`. */
async function findReferencingTasks(
  projectRoot: string,
  targetPath: string
): Promise<{ path: string; group?: string }[]> {
  const allPaths = [...(await listActiveTaskPaths(projectRoot)), ...(await listDoneTaskPaths(projectRoot))];
  const results: { path: string; group?: string }[] = [];
  for (const relPath of allPaths) {
    if (relPath === targetPath) continue;
    const raw = await fs.readFile(absolutePathFor(projectRoot, relPath), "utf8");
    const { frontmatter } = parseFrontmatter(raw);
    const deps = frontmatter.dependencies ?? [];
    const basedOn = frontmatter.based_on ?? [];
    if (deps.includes(targetPath) || basedOn.includes(targetPath)) {
      results.push({ path: relPath, group: frontmatter.group ? String(frontmatter.group) : undefined });
    }
  }
  return results;
}

function toSummary(relPath: string, fm: TaskFrontmatter): TaskSummary {
  return {
    path: relPath,
    title: String(fm.title ?? ""),
    status: String(fm.status ?? ""),
    priority: fm.priority ? String(fm.priority) : undefined,
    type: String(fm.type ?? ""),
    group: fm.group ? String(fm.group) : undefined,
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
  group?: string;
  dependencies?: string[];
  based_on?: string[];
}

export async function createTask(projectRoot: string, input: CreateTaskInput): Promise<TaskSummary> {
  const config = await getConfig(projectRoot);
  const { title, type } = input;
  if (!title || !title.trim()) throw new TaskManagerError("invalid_input", "title is required");
  if (!type || !type.trim()) throw new TaskManagerError("invalid_input", "type is required");

  const slug = slugify(title);
  if (!slug)
    throw new TaskManagerError("invalid_input", `Could not derive a filename slug from title "${title}"`);
  const relPath = `${slug}.md`;

  await assertNoCollision(projectRoot, relPath);

  const configuredTypes = Object.keys(config.types);
  if (configuredTypes.length > 0 && !configuredTypes.includes(type)) {
    throw new TaskManagerError("unknown_type", `Unknown type "${type}". Defined types: ${configuredTypes.join(", ")}`);
  }

  const status = input.status ?? "created";
  if (!config.statuses.includes(status)) {
    throw new TaskManagerError(
      "unknown_status",
      `Unknown status "${status}". Defined statuses: ${config.statuses.join(", ")}`
    );
  }

  let priority: string | undefined = input.priority;
  if (priority !== undefined && config.priorities.length > 0 && !config.priorities.includes(priority)) {
    throw new TaskManagerError(
      "unknown_priority",
      `Unknown priority "${priority}". Defined priorities: ${config.priorities.join(", ")}`
    );
  }
  if (priority === undefined && config.priorities.length > 0) {
    priority = config.priorities[0];
  }

  const dependencies = input.dependencies ?? [];
  for (const dep of dependencies) {
    const resolved = await resolveDependencyLocation(projectRoot, dep);
    if (!resolved) {
      throw new TaskManagerError(
        "unresolved_dependency",
        `Dependency "${dep}" does not point to an existing task (checked tasks/ and tasks/done/).`
      );
    }
  }

  const basedOn = input.based_on ?? [];
  for (const source of basedOn) {
    const resolved = await resolveDependencyLocation(projectRoot, source);
    if (!resolved) {
      throw new TaskManagerError(
        "unresolved_based_on",
        `based_on "${source}" does not point to an existing task (checked tasks/ and tasks/done/).`
      );
    }
  }

  const linkedGroups = await resolveLinkedGroups(projectRoot, [...dependencies, ...basedOn]);
  const group = reconcileGroup(input.group, linkedGroups);

  const typeDef = config.types[type];
  const body = generateSectionsMarkdown(typeDef?.sections, 2);

  const now = new Date().toISOString();
  const frontmatter: TaskFrontmatter = {
    id: randomUUID(),
    ...(group !== undefined ? { group } : {}),
    title,
    type,
    status,
    created_at: now,
    updated_at: now,
  };
  if (priority !== undefined) frontmatter.priority = priority;
  if (dependencies.length > 0) frontmatter.dependencies = dependencies;
  if (basedOn.length > 0) frontmatter.based_on = basedOn;

  const activeAbs = absolutePathFor(projectRoot, relPath);
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
  group?: string;
  include_done?: boolean;
}

export async function listTasks(projectRoot: string, filters: ListTasksFilters = {}): Promise<TaskSummary[]> {
  await getConfig(projectRoot);
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
    if (filters.group && frontmatter.group !== filters.group) continue;
    results.push(toSummary(relPath, frontmatter));
  }
  return results;
}

// ---------------------------------------------------------------------------
// get_tasks_by_group
// ---------------------------------------------------------------------------

/**
 * Returns every task (active AND in tasks/done/, regardless of status)
 * belonging to `group`. Unlike list_tasks, tasks/done/ is always included
 * here: a group is meant to be looked up as a whole, and its tasks routinely
 * finish (and so move to tasks/done/) at different times.
 */
export async function getTasksByGroup(projectRoot: string, group: string): Promise<TaskSummary[]> {
  await getConfig(projectRoot);
  if (!group || !group.trim()) {
    throw new TaskManagerError("invalid_input", "group is required");
  }

  const relPaths = [...(await listActiveTaskPaths(projectRoot)), ...(await listDoneTaskPaths(projectRoot))];
  const results: TaskSummary[] = [];
  for (const relPath of relPaths) {
    const abs = absolutePathFor(projectRoot, relPath);
    const raw = await fs.readFile(abs, "utf8");
    const { frontmatter } = parseFrontmatter(raw);
    if (frontmatter.group !== group) continue;
    results.push(toSummary(relPath, frontmatter));
  }
  return results;
}

// ---------------------------------------------------------------------------
// get_task / get_section
// ---------------------------------------------------------------------------

export async function getTask(projectRoot: string, relPath: string): Promise<TaskFull> {
  await getConfig(projectRoot);
  const { relPath: normalized, frontmatter, body } = await readRawTask(projectRoot, relPath);
  return { path: normalized, frontmatter, sections: toSectionTree(body) };
}

export async function getSection(projectRoot: string, relPath: string, sectionPath: string) {
  await getConfig(projectRoot);
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
    throw new TaskManagerError(
      "not_found",
      `Section "${sectionPath}" is not defined for type "${type}" in task-config.yaml`
    );
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

  const configuredTypes = Object.keys(config.types);
  if (configuredTypes.length > 0 && !configuredTypes.includes(String(frontmatter.type))) {
    issues.push({ type: "unrecognized_type", message: `Unrecognized type "${frontmatter.type}"` });
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

  for (const source of frontmatter.based_on ?? []) {
    const resolved = await resolveDependencyLocation(projectRoot, source);
    if (!resolved) {
      issues.push({ type: "broken_based_on", message: `based_on "${source}" does not exist`, path: source });
    }
  }

  const ownGroup = frontmatter.group !== undefined ? String(frontmatter.group) : undefined;
  if (ownGroup !== undefined) {
    const links = [...(frontmatter.dependencies ?? []), ...(frontmatter.based_on ?? [])];
    const linkedGroups = await resolveLinkedGroups(projectRoot, links);
    for (const [linkPath, linkGroup] of linkedGroups) {
      if (linkGroup !== ownGroup) {
        issues.push({
          type: "group_mismatch",
          message: `group "${ownGroup}" differs from linked task "${linkPath}"'s group "${linkGroup}"`,
          path: linkPath,
        });
      }
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

/**
 * Walks `expected` (the config-defined sections for this level) against the
 * headings actually present in the file, and records one insertion per
 * contiguous run of missing siblings, positioned right before the next
 * sibling that IS present (or at the end of the parent's content if none of
 * the remaining expected siblings are present either). This is what keeps a
 * restored section in its config-defined position instead of always being
 * appended at the end of the file, regardless of where it belongs among its
 * siblings.
 */
function computeMissingInsertions(
  expected: SectionDef[] | undefined,
  actualNodes: ReturnType<typeof parseBody>["roots"],
  parentEndLine: number,
  level: number,
  insertions: Insertion[]
): void {
  if (!expected || expected.length === 0) return;
  const actualHeadings = actualNodes.filter((n) => n.kind === "heading");
  const findActual = (name: string) => actualHeadings.find((n) => n.name === name);

  let i = 0;
  while (i < expected.length) {
    const match = findActual(expected[i].name);
    if (match) {
      computeMissingInsertions(expected[i].sections, match.children, match.contentEnd, level + 1, insertions);
      i += 1;
      continue;
    }

    const missingRun: SectionDef[] = [];
    let j = i;
    while (j < expected.length && !findActual(expected[j].name)) {
      missingRun.push(expected[j]);
      j += 1;
    }
    const nextPresent = j < expected.length ? findActual(expected[j].name) : undefined;
    const atLine = nextPresent ? nextPresent.lineIndex : parentEndLine;
    insertions.push({ atLine, text: generateSectionsMarkdown(missingRun, level) });
    i = j;
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
    // A trailing blank line is needed whenever the insertion lands before an
    // existing sibling (rather than at the very end of the file), so the
    // restored section stays visually separated from what follows it.
    const needsTrailingBlank = lines[ins.atLine] !== undefined && lines[ins.atLine].trim() !== "";
    const toInsert = [...(needsLeadingBlank ? [""] : []), ...block, ...(needsTrailingBlank ? [""] : [])];
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
      throw new TaskManagerError("collision", `Cannot move task to tasks/done/: "${target}" already exists there.`);
    }
    await ensureDirFor(targetAbs);
    await fs.rename(absolutePathFor(projectRoot, relPath), targetAbs);
    return target;
  }

  if (oldStatus === "finished" && newStatus !== "finished" && currentlyInDone) {
    const target = relPath.slice(DONE_SUBDIR.length + 1);
    const targetAbs = absolutePathFor(projectRoot, target);
    if (await fileExists(targetAbs)) {
      throw new TaskManagerError(
        "collision",
        `Cannot move task out of tasks/done/: "${target}" already exists there.`
      );
    }
    await ensureDirFor(targetAbs);
    await fs.rename(absolutePathFor(projectRoot, relPath), targetAbs);
    return target;
  }

  return relPath;
}

export async function updateTask(projectRoot: string, relPath: string, input: UpdateTaskInput): Promise<TaskFull> {
  const config = await getConfig(projectRoot);
  if (input.frontmatter && "type" in input.frontmatter && input.frontmatter.type !== undefined) {
    throw new TaskManagerError("invalid_operation", 'The "type" field cannot be changed via update_task.');
  }
  // Title changes are cosmetic only: update_task never renames the file, since
  // the task is identified by its path, not by its title (see move_task for
  // the only supported way to change a task's path).
  const current = await readRawTask(projectRoot, relPath);
  const oldStatus = current.frontmatter.status;

  const providedFrontmatter = Object.fromEntries(
    Object.entries(input.frontmatter ?? {}).filter(([, v]) => v !== undefined)
  );
  const mergedFrontmatter: TaskFrontmatter = { ...current.frontmatter, ...providedFrontmatter };

  // An explicit empty string clears the group rather than setting a blank one.
  if (input.frontmatter?.group !== undefined && String(input.frontmatter.group).trim() === "") {
    delete mergedFrontmatter.group;
  }

  if (input.frontmatter?.status !== undefined && !config.statuses.includes(String(mergedFrontmatter.status))) {
    throw new TaskManagerError(
      "unknown_status",
      `Unknown status "${mergedFrontmatter.status}". Defined statuses: ${config.statuses.join(", ")}`
    );
  }
  if (
    input.frontmatter?.priority !== undefined &&
    config.priorities.length > 0 &&
    !config.priorities.includes(String(mergedFrontmatter.priority))
  ) {
    throw new TaskManagerError(
      "unknown_priority",
      `Unknown priority "${mergedFrontmatter.priority}". Defined priorities: ${config.priorities.join(", ")}`
    );
  }

  const mergedGroup = mergedFrontmatter.group !== undefined ? String(mergedFrontmatter.group) : undefined;
  const mergedLinks = [...(mergedFrontmatter.dependencies ?? []), ...(mergedFrontmatter.based_on ?? [])];
  if (mergedLinks.length > 0) {
    const linkedGroups = await resolveLinkedGroups(projectRoot, mergedLinks);
    const reconciled = reconcileGroup(mergedGroup, linkedGroups);
    if (reconciled !== undefined) mergedFrontmatter.group = reconciled;
  }

  // The forward check above only covers this task's own links. If `group` is
  // itself being changed, tasks that link back to this one (via their own
  // dependencies/based_on) were validated against the *old* value at their
  // own create/update time, so they must be re-checked against the new one.
  if (input.frontmatter?.group !== undefined) {
    const finalGroup = mergedFrontmatter.group !== undefined ? String(mergedFrontmatter.group) : undefined;
    if (finalGroup !== undefined) {
      const referencing = await findReferencingTasks(projectRoot, current.relPath);
      const conflicting = referencing.find((r) => r.group !== undefined && r.group !== finalGroup);
      if (conflicting) {
        throw new TaskManagerError(
          "group_conflict",
          `group "${finalGroup}" conflicts with the group "${conflicting.group}" of linked task "${conflicting.path}"`
        );
      }
    }
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
  await getConfig(projectRoot);
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
  await getConfig(projectRoot);
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
  await getConfig(projectRoot);
  const { abs, relPath: normalized } = await readRawTask(projectRoot, relPath);
  await fs.unlink(abs);
  void normalized;
}

// ---------------------------------------------------------------------------
// move_task
// ---------------------------------------------------------------------------

/**
 * Isolated, reusable method: rewrites the `dependencies` and `based_on`
 * lists of every other task (active and done) that references `oldPath`,
 * pointing it at `newPath` instead. Used by move_task so a rename never
 * leaves the rest of the backlog with a dangling/stale path. Returns the
 * paths of the tasks it updated.
 */
async function updateDependencyReferences(
  projectRoot: string,
  oldPath: string,
  newPath: string
): Promise<string[]> {
  const allPaths = [...(await listActiveTaskPaths(projectRoot)), ...(await listDoneTaskPaths(projectRoot))];
  const updated: string[] = [];
  for (const relPath of allPaths) {
    if (relPath === newPath) continue;
    const abs = absolutePathFor(projectRoot, relPath);
    const raw = await fs.readFile(abs, "utf8");
    const { frontmatter, body } = parseFrontmatter(raw);
    const deps = frontmatter.dependencies;
    const basedOn = frontmatter.based_on;
    const hasDep = deps?.includes(oldPath) ?? false;
    const hasBasedOn = basedOn?.includes(oldPath) ?? false;
    if (!hasDep && !hasBasedOn) continue;
    const newFrontmatter: TaskFrontmatter = {
      ...frontmatter,
      ...(hasDep ? { dependencies: deps!.map((d) => (d === oldPath ? newPath : d)) } : {}),
      ...(hasBasedOn ? { based_on: basedOn!.map((d) => (d === oldPath ? newPath : d)) } : {}),
      updated_at: new Date().toISOString(),
    };
    await writeRawTask(abs, newFrontmatter, body);
    updated.push(relPath);
  }
  return updated;
}

export interface MoveTaskResult extends TaskSummary {
  updatedDependents: string[];
}

/**
 * Pure path rename: moves a task .md file from one path to another. Never
 * touches `status` (path and status are independent concepts — moving a
 * file in/out of tasks/done/ this way does NOT change its status field; use
 * update_task/change_status for that) and never renames based on `title`.
 * Fails on a destination collision. Propagates the new path into every
 * other task's `dependencies` list via updateDependencyReferences.
 */
export async function moveTask(projectRoot: string, fromPath: string, toPath: string): Promise<MoveTaskResult> {
  await getConfig(projectRoot);
  const current = await readRawTask(projectRoot, fromPath);
  const targetRelPath = normalizeTaskPath(toPath);

  if (targetRelPath === current.relPath) {
    throw new TaskManagerError("invalid_input", `Source and destination are the same: "${targetRelPath}"`);
  }
  if (await fileExists(absolutePathFor(projectRoot, targetRelPath))) {
    throw new TaskManagerError(
      "collision",
      `A task already exists at "${targetRelPath}". Choose a different destination path.`
    );
  }

  const targetAbs = absolutePathFor(projectRoot, targetRelPath);
  await ensureDirFor(targetAbs);
  await fs.rename(current.abs, targetAbs);

  const updatedDependents = await updateDependencyReferences(projectRoot, current.relPath, targetRelPath);

  return { ...toSummary(targetRelPath, current.frontmatter), updatedDependents };
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
