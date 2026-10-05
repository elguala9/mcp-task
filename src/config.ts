import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { RESERVED_STATUSES } from "./types.js";
import { TaskManagerError } from "./errors.js";
import type { TaskConfig, SectionDef, SectionPresence, TypeDef } from "./types.js";

const CONFIG_FILENAME = "task-config.yaml";
const EXAMPLE_CONFIG_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "task-config-example.yaml");

function ensureReservedStatuses(statuses: unknown): string[] {
  const list = Array.isArray(statuses) ? statuses.map((s) => String(s)) : [];
  const merged = [...list];
  for (const reserved of RESERVED_STATUSES) {
    if (!merged.includes(reserved)) merged.push(reserved);
  }
  return merged;
}

function normalizeSections(sections: unknown, seenNames: Set<string>, typeName: string): SectionDef[] | undefined {
  if (sections === undefined || sections === null) return undefined;
  if (!Array.isArray(sections)) {
    throw new TaskManagerError("invalid_config", `Invalid "sections" for type "${typeName}": expected a list`);
  }
  return sections.map((raw) => normalizeSection(raw, seenNames, typeName));
}

function normalizePresence(raw: unknown, sectionName: string, typeName: string): SectionPresence | undefined {
  if (raw === undefined || raw === null) return undefined;
  const value = String(raw).trim().toLowerCase();
  if (value === "mandatory") return "Mandatory";
  if (value === "optional") return "Optional";
  throw new TaskManagerError(
    "invalid_config",
    `Invalid "presence" "${String(raw)}" for section "${sectionName}" of type "${typeName}": expected Mandatory or Optional`
  );
}

function normalizeSection(raw: unknown, seenNames: Set<string>, typeName: string): SectionDef {
  if (typeof raw !== "object" || raw === null || !("name" in raw)) {
    throw new TaskManagerError(
      "invalid_config",
      `Invalid section entry for type "${typeName}": each section needs a "name"`
    );
  }
  const obj = raw as Record<string, unknown>;
  const name = String(obj.name);
  if (seenNames.has(name)) {
    throw new TaskManagerError(
      "invalid_config",
      `Duplicate section name "${name}" for type "${typeName}": section names must be unique within a type, regardless of nesting level`
    );
  }
  seenNames.add(name);
  const description = obj.description !== undefined ? String(obj.description) : undefined;
  const presence = normalizePresence(obj.presence, name, typeName);
  const children = normalizeSections(obj.sections, seenNames, typeName);
  const section: SectionDef = { name };
  if (description !== undefined) section.description = description;
  if (presence !== undefined) section.presence = presence;
  if (children) section.sections = children;
  return section;
}

function normalizeTypes(types: unknown): Record<string, TypeDef> {
  if (types === undefined || types === null) return {};
  if (typeof types !== "object")
    throw new TaskManagerError("invalid_config", 'Invalid "types" in task-config.yaml: expected a map');
  const result: Record<string, TypeDef> = {};
  for (const [typeName, def] of Object.entries(types as Record<string, unknown>)) {
    const defObj = (def ?? {}) as Record<string, unknown>;
    const seenNames = new Set<string>();
    const sections = normalizeSections(defObj.sections, seenNames, typeName);
    result[typeName] = sections ? { sections } : {};
  }
  return result;
}

/**
 * Reads task-config.yaml from `projectRoot` and creates it from the packaged
 * template first if it doesn't exist yet, so every operation always has a
 * config file on disk to work against instead of silently falling back to
 * an in-memory default that the user never sees.
 */
async function readOrCreateConfigFile(projectRoot: string): Promise<string> {
  const configPath = path.join(projectRoot, CONFIG_FILENAME);
  try {
    return await fs.readFile(configPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  await initConfig(projectRoot);
  return fs.readFile(configPath, "utf8");
}

export async function loadConfig(projectRoot: string): Promise<TaskConfig> {
  const raw = await readOrCreateConfigFile(projectRoot);
  const data = (yaml.load(raw) ?? {}) as Record<string, unknown>;
  return {
    statuses: ensureReservedStatuses(data.statuses),
    priorities: Array.isArray(data.priorities) ? data.priorities.map((p) => String(p)) : [],
    types: normalizeTypes(data.types),
  };
}

/**
 * Loads and validates task-config.yaml, throwing a standardized
 * TaskManagerError if it is malformed. Every operation entry point calls
 * this first, so a broken config is caught before any command runs, not
 * only when a command happens to touch the fields that are wrong.
 */
export async function validateConfig(projectRoot: string): Promise<TaskConfig> {
  return loadConfig(projectRoot);
}

/**
 * Creates task-config.yaml from the packaged example template. Fails with
 * "collision" if the file already exists, unless `force` is set.
 */
export async function initConfig(projectRoot: string, options: { force?: boolean } = {}): Promise<{ path: string }> {
  const configPath = path.join(projectRoot, CONFIG_FILENAME);
  if (!options.force) {
    try {
      await fs.access(configPath);
      throw new TaskManagerError("collision", `${CONFIG_FILENAME} already exists at ${configPath}`);
    } catch (err) {
      if (err instanceof TaskManagerError) throw err;
      // ENOENT: no existing file, fall through and create it.
    }
  }
  const template = await fs.readFile(EXAMPLE_CONFIG_PATH, "utf8");
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.writeFile(configPath, template, "utf8");
  return { path: configPath };
}

export const DATA_DIRNAME = ".task_manager";

const INSTRUCTIONS_FILENAME = "TASK-MANAGER.md";
const EXAMPLE_INSTRUCTIONS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "TASK-MANAGER-example.md");

export interface InitResult {
  config: { path: string; created: boolean };
  directories: string[];
  instructions?: { path: string; created: boolean };
}

async function copyTemplate(template: string, dest: string, overwrite: boolean): Promise<boolean> {
  if (!overwrite) {
    try {
      await fs.access(dest);
      return false;
    } catch {
      // ENOENT: fall through and create it.
    }
  }
  await fs.writeFile(dest, await fs.readFile(template, "utf8"), "utf8");
  return true;
}

/**
 * Sets up a project in one go: task-config.yaml, .task_manager/tasks/ and
 * .task_manager/groups/. TASK-MANAGER.md (agent instructions) is only written
 * when `instructions` is set. Unlike initConfig, existing files are left
 * untouched (reported with created: false) unless `force` is set.
 */
export async function initProject(
  projectRoot: string,
  options: { force?: boolean; instructions?: boolean } = {}
): Promise<InitResult> {
  const force = options.force ?? false;
  await fs.mkdir(projectRoot, { recursive: true });
  const configPath = path.join(projectRoot, CONFIG_FILENAME);
  const configCreated = await copyTemplate(EXAMPLE_CONFIG_PATH, configPath, force);
  const directories = [tasksDir(projectRoot), groupsDir(projectRoot)];
  for (const dir of directories) await fs.mkdir(dir, { recursive: true });
  const result: InitResult = { config: { path: configPath, created: configCreated }, directories };
  if (options.instructions) {
    const instructionsPath = path.join(projectRoot, INSTRUCTIONS_FILENAME);
    result.instructions = {
      path: instructionsPath,
      created: await copyTemplate(EXAMPLE_INSTRUCTIONS_PATH, instructionsPath, force),
    };
  }
  return result;
}

export function tasksDir(projectRoot: string): string {
  return path.join(projectRoot, DATA_DIRNAME, "tasks");
}

export function groupsDir(projectRoot: string): string {
  return path.join(projectRoot, DATA_DIRNAME, "groups");
}

export function doneDir(projectRoot: string): string {
  return path.join(projectRoot, DATA_DIRNAME, "tasks", "done");
}
