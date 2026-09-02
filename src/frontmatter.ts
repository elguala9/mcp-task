import yaml from "js-yaml";
import type { TaskFrontmatter } from "./types.js";

export interface ParsedFile {
  frontmatter: TaskFrontmatter;
  body: string;
}

export function parseFrontmatter(raw: string): ParsedFile {
  const normalized = raw.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n") && normalized !== "---") {
    throw new Error("Task file is missing YAML frontmatter delimited by '---'");
  }
  const rest = normalized.slice(4);
  const endIdx = rest.indexOf("\n---");
  if (endIdx === -1) {
    throw new Error("Task file frontmatter is not properly closed with '---'");
  }
  const yamlBlock = rest.slice(0, endIdx);
  let after = rest.slice(endIdx + 4);
  if (after.startsWith("\n")) after = after.slice(1);
  else if (after.startsWith("\r\n")) after = after.slice(2);

  const data = (yaml.load(yamlBlock) ?? {}) as TaskFrontmatter;
  return { frontmatter: data, body: after };
}

export function serializeFile(frontmatter: TaskFrontmatter, body: string): string {
  const yamlBlock = yaml.dump(frontmatter, { lineWidth: -1, noRefs: true }).trimEnd();
  const trimmedBody = body.trim();
  const bodyPart = trimmedBody.length > 0 ? `\n${trimmedBody}\n` : "\n";
  return `---\n${yamlBlock}\n---\n${bodyPart}`;
}
