import { test } from "node:test";
import assert from "node:assert/strict";
import {
  toSectionTree,
  parseBody,
  resolveSectionPath,
  replaceSectionContent,
  appendToSectionContent,
} from "../src/sectionTree.js";

const BODY = `## Descrizione
Testo libero.

### Sottosezione1
dettagli

## Note
- nota 1
- nota 2

## Checklist
- [ ] primo punto
- [ ] secondo punto
  - [ ] sotto-punto
    - [ ] sotto-sotto-punto
`;

test("toSectionTree nests headings correctly", () => {
  const tree = toSectionTree(BODY);
  assert.equal(tree.length, 3);
  assert.equal(tree[0].name, "Descrizione");
  assert.equal(tree[0].children.length, 1);
  assert.equal(tree[0].children[0].name, "Sottosezione1");
  assert.equal(tree[0].children[0].content, "dettagli");
});

test("toSectionTree nests checklist items by indentation", () => {
  const tree = toSectionTree(BODY);
  const checklist = tree.find((n) => n.name === "Checklist")!;
  assert.equal(checklist.children.length, 2);
  const secondo = checklist.children[1];
  assert.equal(secondo.name, "secondo punto");
  assert.equal(secondo.children[0].name, "sotto-punto");
  assert.equal(secondo.children[0].children[0].name, "sotto-sotto-punto");
});

test("resolveSectionPath resolves exact chain", () => {
  const parsed = parseBody(BODY);
  const { node } = resolveSectionPath(parsed, "Descrizione > Sottosezione1");
  assert.equal(node.name, "Sottosezione1");
});

test("resolveSectionPath resolves unique-name shorthand", () => {
  const parsed = parseBody(BODY);
  const { node } = resolveSectionPath(parsed, "Sottosezione1");
  assert.equal(node.name, "Sottosezione1");
});

test("resolveSectionPath throws on missing section", () => {
  const parsed = parseBody(BODY);
  assert.throws(() => resolveSectionPath(parsed, "Nope"), /not found/);
});

test("resolveSectionPath throws on ambiguous name", () => {
  const parsed = parseBody(`## A
### X
## B
### X
`);
  assert.throws(() => resolveSectionPath(parsed, "X"), /Ambiguous/);
});

test("replaceSectionContent overwrites only the target section", () => {
  const updated = replaceSectionContent(BODY, "Note", "- nuova nota");
  assert.match(updated, /## Note\n- nuova nota\n/);
  assert.match(updated, /## Checklist\n- \[ \] primo punto/);
  assert.doesNotMatch(updated, /nota 1/);
});

test("appendToSectionContent appends without touching existing content", () => {
  const updated = appendToSectionContent(BODY, "Checklist", "- [ ] terzo punto");
  const tree = toSectionTree(updated);
  const checklist = tree.find((n) => n.name === "Checklist")!;
  assert.equal(checklist.children.length, 3);
  assert.equal(checklist.children[2].name, "terzo punto");
});

test("appendToSectionContent on a nested list item adds a sub-item", () => {
  const updated = appendToSectionContent(BODY, "Checklist > secondo punto", "  - [ ] extra");
  const tree = toSectionTree(updated);
  const checklist = tree.find((n) => n.name === "Checklist")!;
  const secondo = checklist.children.find((n) => n.name === "secondo punto")!;
  assert.equal(secondo.children.length, 2);
  assert.equal(secondo.children[1].name, "extra");
});

test("code fences are not parsed as headings or list items", () => {
  const body = `## Descrizione
\`\`\`
## not a heading
- not a list item
\`\`\`
`;
  const tree = toSectionTree(body);
  assert.equal(tree.length, 1);
  assert.equal(tree[0].children.length, 0);
});
