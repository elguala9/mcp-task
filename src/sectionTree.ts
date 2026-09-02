import type { SectionNode } from "./types.js";

interface RawNode {
  name: string;
  kind: "heading" | "list";
  level: number; // heading level (1-6) or list indentation (spaces)
  checkbox: " " | "x" | null;
  lineIndex: number; // index of the node's own line in `lines`
  contentEnd: number; // exclusive end line index (set once the node is closed)
  children: RawNode[];
}

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;
const LIST_ITEM_RE = /^(\s*)[-*]\s+(?:\[([ xX])\]\s+)?(.+?)\s*$/;
const FENCE_RE = /^\s*```/;

function stripInlineMarkers(text: string): string {
  return text.trim();
}

/**
 * Parses a task body into a heading/list-item tree. Headings always outrank
 * list items regardless of nesting; list items nest by indentation under the
 * nearest open heading or list item.
 */
function buildRawTree(lines: string[]): { roots: RawNode[]; all: RawNode[] } {
  const roots: RawNode[] = [];
  const all: RawNode[] = [];
  const stack: RawNode[] = [];
  let inFence = false;

  const closeTo = (predicate: (top: RawNode) => boolean, closeLine: number) => {
    while (stack.length > 0 && predicate(stack[stack.length - 1])) {
      const node = stack.pop()!;
      node.contentEnd = closeLine;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const headingMatch = HEADING_RE.exec(line);
    if (headingMatch) {
      const level = headingMatch[1].length;
      // list items never survive past a heading; headings always outrank lists
      closeTo((top) => top.kind === "list", i);
      const node: RawNode = {
        name: stripInlineMarkers(headingMatch[2]),
        kind: "heading",
        level,
        checkbox: null,
        lineIndex: i,
        contentEnd: lines.length,
        children: [],
      };
      // pop headings of same/deeper level
      while (
        stack.length > 0 &&
        stack[stack.length - 1].kind === "heading" &&
        stack[stack.length - 1].level >= level
      ) {
        const popped = stack.pop()!;
        popped.contentEnd = i;
      }
      const parent = stack[stack.length - 1];
      if (parent) parent.children.push(node);
      else roots.push(node);
      all.push(node);
      stack.push(node);
      continue;
    }

    const listMatch = LIST_ITEM_RE.exec(line);
    if (listMatch) {
      const indent = listMatch[1].length;
      const checkbox = (listMatch[2] ? (listMatch[2].toLowerCase() as "x") : (listMatch[2] === "" ? " " : null)) as
        | " "
        | "x"
        | null;
      // pop list items with indent >= this one (siblings/deeper)
      while (stack.length > 0 && stack[stack.length - 1].kind === "list" && stack[stack.length - 1].level >= indent) {
        const popped = stack.pop()!;
        popped.contentEnd = i;
      }
      const node: RawNode = {
        name: stripInlineMarkers(listMatch[3]),
        kind: "list",
        level: indent,
        checkbox: listMatch[2] !== undefined ? checkbox : null,
        lineIndex: i,
        contentEnd: lines.length,
        children: [],
      };
      const parent = stack[stack.length - 1];
      if (parent) parent.children.push(node);
      else roots.push(node);
      all.push(node);
      stack.push(node);
      continue;
    }
    // plain content line: belongs to whatever node is currently open (no tree impact)
  }

  while (stack.length > 0) {
    const node = stack.pop()!;
    node.contentEnd = lines.length;
  }

  return { roots, all };
}

function ownContentLines(node: RawNode, lines: string[]): string[] {
  const firstChildLine = node.children.length > 0 ? node.children[0].lineIndex : node.contentEnd;
  return lines.slice(node.lineIndex + 1, firstChildLine);
}

function toSectionNode(node: RawNode, lines: string[]): SectionNode {
  return {
    name: node.name,
    kind: node.kind,
    checkbox: node.kind === "list" ? node.checkbox : undefined,
    content: ownContentLines(node, lines).join("\n").trim(),
    children: node.children.map((c) => toSectionNode(c, lines)),
  };
}

export interface ParsedBody {
  lines: string[];
  roots: RawNode[];
  all: RawNode[];
}

export function parseBody(body: string): ParsedBody {
  const lines = body.replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n");
  const { roots, all } = buildRawTree(lines);
  return { lines, roots, all };
}

export function toSectionTree(body: string): SectionNode[] {
  const { roots, lines } = parseBody(body);
  return roots.map((r) => toSectionNode(r, lines));
}

export function rawNodeToSectionNode(node: RawNode, lines: string[]): SectionNode {
  return toSectionNode(node, lines);
}

export interface SectionLocation {
  node: RawNode;
  chain: RawNode[]; // root..node
}

function chainName(chain: RawNode[]): string {
  return chain.map((n) => n.name).join(" > ");
}

/**
 * Resolves a " > "-separated section path against the parsed tree.
 * First tries an exact path match from the root; if that fails, searches
 * the whole tree for a unique node whose ancestor-name-chain ends with the
 * given path segments, throwing on zero or multiple matches.
 */
export function resolveSectionPath(parsed: ParsedBody, sectionPath: string): SectionLocation {
  const segments = sectionPath
    .split(">")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (segments.length === 0) {
    throw new Error("Section path must not be empty");
  }

  // exact path from root
  let candidates: RawNode[] = parsed.roots;
  let chain: RawNode[] = [];
  let exactOk = true;
  for (const segment of segments) {
    const match = candidates.find((n) => n.name === segment);
    if (!match) {
      exactOk = false;
      break;
    }
    chain.push(match);
    candidates = match.children;
  }
  if (exactOk && chain.length === segments.length) {
    return { node: chain[chain.length - 1], chain };
  }

  // fallback: unique suffix match anywhere in the tree
  const matches: SectionLocation[] = [];
  const walk = (nodes: RawNode[], ancestors: RawNode[]) => {
    for (const node of nodes) {
      const fullChain = [...ancestors, node];
      const names = fullChain.map((n) => n.name);
      if (names.length >= segments.length) {
        const tail = names.slice(names.length - segments.length);
        if (tail.every((n, idx) => n === segments[idx])) {
          matches.push({ node, chain: fullChain });
        }
      }
      walk(node.children, fullChain);
    }
  };
  walk(parsed.roots, []);

  if (matches.length === 0) {
    throw new Error(`Section not found: "${sectionPath}"`);
  }
  if (matches.length > 1) {
    const options = matches.map((m) => chainName(m.chain)).join("; ");
    throw new Error(`Ambiguous section path "${sectionPath}", matches: ${options}`);
  }
  return matches[0];
}

export function replaceSectionContent(body: string, sectionPath: string, newContent: string): string {
  const parsed = parseBody(body);
  const { node } = resolveSectionPath(parsed, sectionPath);
  const before = parsed.lines.slice(0, node.lineIndex + 1);
  const after = parsed.lines.slice(node.contentEnd);
  const trimmedNew = newContent.replace(/\s+$/, "");
  const middle = trimmedNew.length > 0 ? trimmedNew.split("\n") : [];
  return [...before, ...middle, ...after].join("\n");
}

export function appendToSectionContent(body: string, sectionPath: string, addedContent: string): string {
  const parsed = parseBody(body);
  const { node } = resolveSectionPath(parsed, sectionPath);
  const before = parsed.lines.slice(0, node.contentEnd);
  const after = parsed.lines.slice(node.contentEnd);
  const trimmedAdd = addedContent.replace(/\s+$/, "");
  const addedLines = trimmedAdd.length > 0 ? trimmedAdd.split("\n") : [];
  return [...before, ...addedLines, ...after].join("\n");
}
