import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { RESERVED_STATUSES } from "./types.js";
import { TaskManagerError } from "./errors.js";
import type { TaskConfig, SectionDef, TypeDef } from "./types.js";

const CONFIG_FILENAME = "task-config.yaml";
const EXAMPLE_CONFIG_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "task-config-example.yaml");

function defaultConfig(): TaskConfig {
  return {
    statuses: [...RESERVED_STATUSES],
    priorities: [],
    types: {},
  };
}

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
  const children = normalizeSections(obj.sections, seenNames, typeName);
  const section: SectionDef = { name };
  if (description !== undefined) section.description = description;
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

export async function loadConfig(projectRoot: string): Promise<TaskConfig> {
  const configPath = path.join(projectRoot, CONFIG_FILENAME);
  let raw: string;
  try {
    raw = await fs.readFile(configPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return defaultConfig();
    }
    throw err;
  }

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

export function tasksDir(projectRoot: string): string {
  return path.join(projectRoot, "tasks");
}

export function doneDir(projectRoot: string): string {
  return path.join(projectRoot, "tasks", "done");
}
