import { promises as fs } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, initProject } from "../src/config.js";
import { makeProject, cleanup, SAMPLE_CONFIG } from "./testUtils.js";

test("loadConfig creates task-config.yaml from the packaged template when it's missing", async () => {
  const root = await makeProject("defaults-when-missing");
  try {
    const configPath = path.join(root, "task-config.yaml");
    await assert.rejects(() => fs.access(configPath)); // not on disk yet

    const config = await loadConfig(root);
    assert.deepEqual(config.statuses, ["created", "finished"]);
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

test("loadConfig always injects the 2 reserved statuses even if omitted", async () => {
  const root = await makeProject("reserved-statuses-injected", "statuses:\n  - created\n  - review\n");
  try {
    const config = await loadConfig(root);
    for (const reserved of ["created", "finished"]) {
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

test("loadConfig parses section presence, defaulting to mandatory and rejecting unknown values", async () => {
  const config = `
types:
  feature:
    sections:
      - name: A
      - name: B
        presence: optional
      - name: C
        presence: Mandatory
`;
  const root = await makeProject("section-presence", config);
  try {
    const sections = (await loadConfig(root)).types.feature.sections!;
    assert.equal(sections[0].presence, undefined);
    assert.equal(sections[1].presence, "Optional");
    assert.equal(sections[2].presence, "Mandatory");
  } finally {
    await cleanup(root);
  }

  const bad = await makeProject("section-presence-invalid", "types:\n  feature:\n    sections:\n      - name: A\n        presence: maybe\n");
  try {
    await assert.rejects(() => loadConfig(bad), /Invalid "presence"/);
  } finally {
    await cleanup(bad);
  }
});

test("initProject creates config and folders, and TASK-MANAGER.md only when requested", async () => {
  const root = await makeProject("init project");
  try {
    await fs.rm(path.join(root, ".task_manager"), { recursive: true, force: true });
    const first = await initProject(root);
    assert.equal(first.config.created, true);
    assert.equal(first.instructions, undefined);
    await fs.access(path.join(root, "task-config.yaml"));
    await fs.access(path.join(root, ".task_manager", "tasks"));
    await fs.access(path.join(root, ".task_manager", "groups"));
    await assert.rejects(fs.access(path.join(root, "TASK-MANAGER.md")));

    const second = await initProject(root, { instructions: true });
    assert.equal(second.config.created, false);
    assert.equal(second.instructions?.created, true);
    await fs.access(path.join(root, "TASK-MANAGER.md"));

    const third = await initProject(root, { instructions: true });
    assert.equal(third.instructions?.created, false);
  } finally {
    await cleanup(root);
  }
});

test("data_dir in task-config.yaml relocates tasks/ and groups/", async () => {
  const root = await makeProject("custom-data-dir", `data_dir: "."\n${SAMPLE_CONFIG}`);
  try {
    const { createTask } = await import("../src/operations.js");
    const created = await createTask(root, { title: "Custom dir", type: "feature", group: "g1" });
    await fs.access(path.join(root, "tasks", `${created.path}`));
    await fs.access(path.join(root, "groups", "g1.md"));
    await assert.rejects(() => fs.access(path.join(root, ".task_manager", "groups")));
  } finally {
    await cleanup(root);
  }
});

test("data_dir rejects absolute or parent paths", async () => {
  const root = await makeProject("bad-data-dir", `data_dir: "../elsewhere"\n${SAMPLE_CONFIG}`);
  try {
    await assert.rejects(() => loadConfig(root), /data_dir/);
  } finally {
    await cleanup(root);
  }
});

test("create_task folder creates the task in a subfolder and rejects unsafe folders", async () => {
  const root = await makeProject("task-folder", SAMPLE_CONFIG);
  try {
    const { createTask, getTask } = await import("../src/operations.js");
    const created = await createTask(root, { title: "In folder", type: "feature", folder: "proj/topic/in-corso" });
    assert.equal(created.path, "proj/topic/in-corso/in-folder.md");
    assert.equal((await getTask(root, created.path)).path, created.path);
    await assert.rejects(() => createTask(root, { title: "x", type: "feature", folder: "../out" }), /Invalid folder/);
    await assert.rejects(() => createTask(root, { title: "y", type: "feature", folder: "done/a" }), /reserved/);
  } finally {
    await cleanup(root);
  }
});
