import { promises as fs } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { makeProject, cleanup, SAMPLE_CONFIG } from "./testUtils.js";

test("loadConfig creates task-config.yaml from the packaged template when it's missing", async () => {
  const root = await makeProject("defaults-when-missing");
  try {
    const configPath = path.join(root, "task-config.yaml");
    await assert.rejects(() => fs.access(configPath)); // not on disk yet

    const config = await loadConfig(root);
    for (const reserved of ["created", "started", "tested", "deployed", "finished"]) {
      assert.ok(config.statuses.includes(reserved));
    }
    assert.ok(config.priorities.length > 0);
    assert.ok(Object.keys(config.types).length > 0);

    await fs.access(configPath); // now created on disk

    // a second call reads the file just created instead of recreating it
    const again = await loadConfig(root);
    assert.deepEqual(again, config);
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
