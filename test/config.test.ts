import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { makeProject, cleanup, SAMPLE_CONFIG } from "./testUtils.js";

test("loadConfig returns reserved-only defaults when task-config.yaml is missing", async () => {
  const root = await makeProject("defaults-when-missing");
  try {
    const config = await loadConfig(root);
    assert.deepEqual(config.statuses, ["created", "started", "tested", "deployed", "finished"]);
    assert.deepEqual(config.priorities, []);
    assert.deepEqual(config.types, {});
  } finally {
    await cleanup(root);
  }
});

test("loadConfig always injects the 5 reserved statuses even if omitted", async () => {
  const root = await makeProject("reserved-statuses-injected", "statuses:\n  - created\n  - review\n");
  try {
    const config = await loadConfig(root);
    for (const reserved of ["created", "started", "tested", "deployed", "finished"]) {
      assert.ok(config.statuses.includes(reserved), `missing reserved status ${reserved}`);
    }
    assert.ok(config.statuses.includes("review"));
  } finally {
    await cleanup(root);
  }
});

test("loadConfig parses nested type sections and descriptions", async () => {
  const root = await makeProject("nested-sections-and-descriptions", SAMPLE_CONFIG);
  try {
    const config = await loadConfig(root);
    const feature = config.types.feature;
    assert.equal(feature.sections?.[0].name, "Descrizione");
    assert.equal(feature.sections?.[0].description, "Spiega cosa va implementato");
    assert.equal(feature.sections?.[0].sections?.[0].name, "Sottosezione1");
    assert.deepEqual(config.types.bug.sections, []);
  } finally {
    await cleanup(root);
  }
});

test("loadConfig rejects duplicate section names within a type", async () => {
  const badConfig = `
types:
  feature:
    sections:
      - name: Descrizione
        sections:
          - name: Descrizione
`;
  const root = await makeProject("duplicate-section-names", badConfig);
  try {
    await assert.rejects(() => loadConfig(root), /Duplicate section name/);
  } finally {
    await cleanup(root);
  }
});
