import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const SANDBOX_ROOT = path.join(process.cwd(), "test", ".sandbox");

let counter = 0;

function slugForDir(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "run";
}

/**
 * Creates a fresh project under test/.sandbox/, named after `label` (usually
 * the test title) so a run's output can be inspected afterwards. The whole
 * sandbox folder is wiped once per `npm test` run by the `pretest` script,
 * not by this function or by cleanup().
 */
export async function makeProject(label: string, configYaml?: string): Promise<string> {
  counter += 1;
  const id = crypto.randomBytes(3).toString("hex");
  const dirName = `${String(counter).padStart(3, "0")}-${slugForDir(label)}-${id}`;
  const root = path.join(SANDBOX_ROOT, dirName);
  await fs.mkdir(path.join(root, ".task_manager", "tasks"), { recursive: true });
  if (configYaml !== undefined) {
    await fs.writeFile(path.join(root, "task-config.yaml"), configYaml, "utf8");
  }
  return root;
}

/** Intentionally a no-op: sandbox output is kept on disk for inspection. */
export async function cleanup(_root: string): Promise<void> {}

export const SAMPLE_CONFIG = `
statuses:
  - created
  - started
  - review
  - tested
  - deployed
  - finished
priorities:
  - low
  - medium
  - high
  - critical
types:
  feature:
    sections:
      - name: Descrizione
        description: "Spiega cosa va implementato"
        sections:
          - name: Sottosezione1
      - name: Note
      - name: Checklist
  fix:
    sections:
      - name: Descrizione
      - name: Checklist
  bug:
    sections: []
`;

export async function readRawFile(root: string, relPath: string): Promise<string> {
  return fs.readFile(path.join(root, ".task_manager", "tasks", relPath), "utf8");
}

export async function fileExistsAt(root: string, relPath: string): Promise<boolean> {
  try {
    await fs.access(path.join(root, ".task_manager", "tasks", relPath));
    return true;
  } catch {
    return false;
  }
}
