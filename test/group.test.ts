import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as ops from "../src/operations.js";
import { makeProject, cleanup, SAMPLE_CONFIG } from "./testUtils.js";

async function withProject(t: TestContext, fn: (root: string) => Promise<void>): Promise<void> {
  const root = await makeProject(t.name, SAMPLE_CONFIG);
  try {
    await fn(root);
  } finally {
    await cleanup(root);
  }
}

// ---------------------------------------------------------------------------
// create_task: field position / basic storage
// ---------------------------------------------------------------------------

test("create_task stores an explicit group with no links", (t) =>
  withProject(t, async (root) => {
    const summary = await ops.createTask(root, { title: "Solo task", type: "bug", group: "g1" });
    const full = await ops.getTask(root, summary.path);
    assert.equal(full.frontmatter.group, "g1");
  }));

test("create_task without a group leaves it unset when there are no links", (t) =>
  withProject(t, async (root) => {
    const summary = await ops.createTask(root, { title: "No group", type: "bug" });
    const full = await ops.getTask(root, summary.path);
    assert.equal(full.frontmatter.group, undefined);
  }));

test("group is serialized directly under id in the frontmatter", (t) =>
  withProject(t, async (root) => {
    await ops.createTask(root, { title: "Ordered", type: "bug", group: "g1" });
    const raw = await (await import("./testUtils.js")).readRawFile(root, "ordered.md");
    const idLine = raw.split("\n").findIndex((l) => l.startsWith("id:"));
    const groupLine = raw.split("\n").findIndex((l) => l.startsWith("group:"));
    assert.ok(idLine >= 0 && groupLine === idLine + 1, `expected group right after id, got:\n${raw}`);
  }));

// ---------------------------------------------------------------------------
// create_task: inheriting a group from linked tasks
// ---------------------------------------------------------------------------

test("create_task inherits the group of a single dependency when none is given", (t) =>
  withProject(t, async (root) => {
    await ops.createTask(root, { title: "Base", type: "bug", group: "g1" });
    const child = await ops.createTask(root, {
      title: "Child",
      type: "bug",
      dependencies: ["base.md"],
    });
    const full = await ops.getTask(root, child.path);
    assert.equal(full.frontmatter.group, "g1");
  }));

test("create_task inherits the group of a single based_on source when none is given", (t) =>
  withProject(t, async (root) => {
    await ops.createTask(root, { title: "Base", type: "bug", group: "g1" });
    const child = await ops.createTask(root, {
      title: "Child",
      type: "bug",
      based_on: ["base.md"],
    });
    const full = await ops.getTask(root, child.path);
    assert.equal(full.frontmatter.group, "g1");
  }));

test("create_task inherits a group shared by both a dependency and a based_on source", (t) =>
  withProject(t, async (root) => {
    await ops.createTask(root, { title: "Dep", type: "bug", group: "g1" });
    await ops.createTask(root, { title: "Source", type: "bug", group: "g1" });
    const child = await ops.createTask(root, {
      title: "Child",
      type: "bug",
      dependencies: ["dep.md"],
      based_on: ["source.md"],
    });
    const full = await ops.getTask(root, child.path);
    assert.equal(full.frontmatter.group, "g1");
  }));

test("create_task with an explicit group matching the linked tasks' group succeeds", (t) =>
  withProject(t, async (root) => {
    await ops.createTask(root, { title: "Base", type: "bug", group: "g1" });
    const child = await ops.createTask(root, {
      title: "Child",
      type: "bug",
      group: "g1",
      dependencies: ["base.md"],
    });
    const full = await ops.getTask(root, child.path);
    assert.equal(full.frontmatter.group, "g1");
  }));

test("create_task does not require a group when linked tasks have none", (t) =>
  withProject(t, async (root) => {
    await ops.createTask(root, { title: "Base", type: "bug" });
    const child = await ops.createTask(root, {
      title: "Child",
      type: "bug",
      dependencies: ["base.md"],
    });
    const full = await ops.getTask(root, child.path);
    assert.equal(full.frontmatter.group, undefined);
  }));

test("create_task allows an explicit group when the linked task has none", (t) =>
  withProject(t, async (root) => {
    await ops.createTask(root, { title: "Base", type: "bug" });
    const child = await ops.createTask(root, {
      title: "Child",
      type: "bug",
      group: "g1",
      dependencies: ["base.md"],
    });
    const full = await ops.getTask(root, child.path);
    assert.equal(full.frontmatter.group, "g1");
  }));

// ---------------------------------------------------------------------------
// create_task: conflicts
// ---------------------------------------------------------------------------

test("create_task rejects an explicit group that conflicts with a dependency's group", (t) =>
  withProject(t, async (root) => {
    await ops.createTask(root, { title: "Base", type: "bug", group: "g1" });
    await assert.rejects(
      () =>
        ops.createTask(root, {
          title: "Child",
          type: "bug",
          group: "g2",
          dependencies: ["base.md"],
        }),
      /group_conflict|conflicts with the group/
    );
  }));

test("create_task rejects an explicit group that conflicts with a based_on source's group", (t) =>
  withProject(t, async (root) => {
    await ops.createTask(root, { title: "Base", type: "bug", group: "g1" });
    await assert.rejects(
      () =>
        ops.createTask(root, {
          title: "Child",
          type: "bug",
          group: "g2",
          based_on: ["base.md"],
        }),
      /conflicts with the group/
    );
  }));

test("create_task rejects linking two tasks that already belong to different groups", (t) =>
  withProject(t, async (root) => {
    await ops.createTask(root, { title: "Base A", type: "bug", group: "g1" });
    await ops.createTask(root, { title: "Base B", type: "bug", group: "g2" });
    await assert.rejects(
      () =>
        ops.createTask(root, {
          title: "Child",
          type: "bug",
          dependencies: ["base-a.md"],
          based_on: ["base-b.md"],
        }),
      /different groups/
    );
  }));

test("a failed create_task due to group conflict does not create the file", (t) =>
  withProject(t, async (root) => {
    await ops.createTask(root, { title: "Base", type: "bug", group: "g1" });
    await assert.rejects(() =>
      ops.createTask(root, { title: "Child", type: "bug", group: "g2", dependencies: ["base.md"] })
    );
    const list = await ops.listTasks(root);
    assert.deepEqual(
      list.map((x) => x.path).sort(),
      ["base.md"]
    );
  }));

// ---------------------------------------------------------------------------
// update_task: forward checks (this task's own dependencies/based_on)
// ---------------------------------------------------------------------------

test("update_task rejects adding a dependency whose group conflicts with the task's own group", (t) =>
  withProject(t, async (root) => {
    await ops.createTask(root, { title: "Base", type: "bug", group: "g1" });
    await ops.createTask(root, { title: "Child", type: "bug", group: "g2" });
    await assert.rejects(
      () => ops.updateTask(root, "child.md", { frontmatter: { dependencies: ["base.md"] } }),
      /conflicts with the group/
    );
  }));

test("update_task allows adding a dependency whose group matches", (t) =>
  withProject(t, async (root) => {
    await ops.createTask(root, { title: "Base", type: "bug", group: "g1" });
    await ops.createTask(root, { title: "Child", type: "bug", group: "g1" });
    const updated = await ops.updateTask(root, "child.md", {
      frontmatter: { dependencies: ["base.md"] },
    });
    assert.deepEqual(updated.frontmatter.dependencies, ["base.md"]);
  }));

test("update_task inherits a group when adding a link to an ungrouped task with no group of its own", (t) =>
  withProject(t, async (root) => {
    await ops.createTask(root, { title: "Base", type: "bug", group: "g1" });
    await ops.createTask(root, { title: "Child", type: "bug" });
    const updated = await ops.updateTask(root, "child.md", {
      frontmatter: { dependencies: ["base.md"] },
    });
    assert.equal(updated.frontmatter.group, "g1");
  }));

test("update_task rejects setting group on a task whose dependency already has a different group", (t) =>
  withProject(t, async (root) => {
    await ops.createTask(root, { title: "Base", type: "bug", group: "g1" });
    await ops.createTask(root, { title: "Child", type: "bug", dependencies: ["base.md"] });
    await assert.rejects(
      () => ops.updateTask(root, "child.md", { frontmatter: { group: "g2" } }),
      /conflicts with the group/
    );
  }));

test("update_task allows setting a matching group on a task with an existing dependency", (t) =>
  withProject(t, async (root) => {
    await ops.createTask(root, { title: "Base", type: "bug", group: "g1" });
    await ops.createTask(root, { title: "Child", type: "bug", dependencies: ["base.md"] });
    const updated = await ops.updateTask(root, "child.md", { frontmatter: { group: "g1" } });
    assert.equal(updated.frontmatter.group, "g1");
  }));

test("update_task can clear a group by passing an empty string", (t) =>
  withProject(t, async (root) => {
    await ops.createTask(root, { title: "Solo", type: "bug", group: "g1" });
    const updated = await ops.updateTask(root, "solo.md", { frontmatter: { group: "" } });
    assert.equal(updated.frontmatter.group, undefined);
  }));

// ---------------------------------------------------------------------------
// update_task: reverse checks (other tasks that link back to this one)
// ---------------------------------------------------------------------------

test("update_task rejects changing a task's group away from what a dependent task expects", (t) =>
  withProject(t, async (root) => {
    await ops.createTask(root, { title: "Base", type: "bug", group: "g1" });
    await ops.createTask(root, { title: "Child", type: "bug", group: "g1", dependencies: ["base.md"] });
    await assert.rejects(
      () => ops.updateTask(root, "base.md", { frontmatter: { group: "g2" } }),
      /conflicts with the group/
    );
  }));

test("update_task rejects changing a based_on source's group away from a derived task's group", (t) =>
  withProject(t, async (root) => {
    await ops.createTask(root, { title: "Base", type: "bug", group: "g1" });
    await ops.createTask(root, { title: "Child", type: "bug", group: "g1", based_on: ["base.md"] });
    await assert.rejects(
      () => ops.updateTask(root, "base.md", { frontmatter: { group: "g2" } }),
      /conflicts with the group/
    );
  }));

test("update_task allows setting a base task's group when no dependent has one yet", (t) =>
  withProject(t, async (root) => {
    // Base starts ungrouped, so Child (which depends on it) has nothing to inherit.
    await ops.createTask(root, { title: "Base", type: "bug" });
    await ops.createTask(root, { title: "Child", type: "bug", dependencies: ["base.md"] });
    const updated = await ops.updateTask(root, "base.md", { frontmatter: { group: "g2" } });
    assert.equal(updated.frontmatter.group, "g2");
  }));

test("update_task allows setting the same group both dependents already share", (t) =>
  withProject(t, async (root) => {
    await ops.createTask(root, { title: "Base", type: "bug" });
    await ops.createTask(root, { title: "Child A", type: "bug", group: "g1", dependencies: ["base.md"] });
    await ops.createTask(root, { title: "Child B", type: "bug", group: "g1", dependencies: ["base.md"] });
    const updated = await ops.updateTask(root, "base.md", { frontmatter: { group: "g1" } });
    assert.equal(updated.frontmatter.group, "g1");
  }));

test("update_task's group conflict check is unaffected by unrelated tasks pointing elsewhere", (t) =>
  withProject(t, async (root) => {
    await ops.createTask(root, { title: "Base", type: "bug", group: "g1" });
    await ops.createTask(root, { title: "Unrelated", type: "bug", group: "g9" });
    const updated = await ops.updateTask(root, "base.md", { frontmatter: { group: "g2" } });
    assert.equal(updated.frontmatter.group, "g2");
  }));

test("update_task reverse-check also considers tasks archived in tasks/done/", (t) =>
  withProject(t, async (root) => {
    await ops.createTask(root, { title: "Base", type: "bug", group: "g1" });
    await ops.createTask(root, { title: "Child", type: "bug", group: "g1", dependencies: ["base.md"] });
    await ops.endTask(root, "child.md");
    await assert.rejects(
      () => ops.updateTask(root, "base.md", { frontmatter: { group: "g2" } }),
      /conflicts with the group/
    );
  }));

// ---------------------------------------------------------------------------
// check_task: auditing group_mismatch on files edited outside these operations
// ---------------------------------------------------------------------------

test("check_task reports group_mismatch when a task's group differs from a dependency's group", (t) =>
  withProject(t, async (root) => {
    await ops.createTask(root, { title: "Base", type: "bug", group: "g1" });
    await ops.createTask(root, { title: "Child", type: "bug", group: "g1", dependencies: ["base.md"] });
    // Force a mismatch the way a manual edit of the file could: bypass the
    // guarded update path entirely and rewrite the underlying file directly.
    const raw = await (await import("./testUtils.js")).readRawFile(root, "base.md");
    const { promises: fs } = await import("node:fs");
    const path = await import("node:path");
    await fs.writeFile(path.join(root, ".task_manager", "tasks", "base.md"), raw.replace("group: g1", "group: g2"), "utf8");

    const report = await ops.checkTask(root, "child.md");
    assert.equal(report.ok, false);
    assert.ok(report.issues.some((i) => i.type === "group_mismatch"));
  }));

test("check_task reports group_mismatch for a based_on source too", (t) =>
  withProject(t, async (root) => {
    await ops.createTask(root, { title: "Base", type: "bug", group: "g1" });
    await ops.createTask(root, { title: "Child", type: "bug", group: "g1", based_on: ["base.md"] });
    const raw = await (await import("./testUtils.js")).readRawFile(root, "base.md");
    const { promises: fs } = await import("node:fs");
    const path = await import("node:path");
    await fs.writeFile(path.join(root, ".task_manager", "tasks", "base.md"), raw.replace("group: g1", "group: g2"), "utf8");

    const report = await ops.checkTask(root, "child.md");
    assert.equal(report.ok, false);
    assert.deepEqual(
      report.issues.filter((i) => i.type === "group_mismatch").map((i) => i.path),
      ["base.md"]
    );
  }));

test("check_task reports no group_mismatch when groups agree", (t) =>
  withProject(t, async (root) => {
    await ops.createTask(root, { title: "Base", type: "bug", group: "g1" });
    await ops.createTask(root, { title: "Child", type: "bug", group: "g1", dependencies: ["base.md"] });
    const report = await ops.checkTask(root, "child.md");
    assert.ok(!report.issues.some((i) => i.type === "group_mismatch"));
  }));

test("check_task reports no group_mismatch when the linked task has no group at all", (t) =>
  withProject(t, async (root) => {
    await ops.createTask(root, { title: "Base", type: "bug" });
    await ops.createTask(root, { title: "Child", type: "bug", group: "g1", dependencies: ["base.md"] });
    const report = await ops.checkTask(root, "child.md");
    assert.ok(!report.issues.some((i) => i.type === "group_mismatch"));
  }));

test("check_task does not report group_mismatch for a task with no group of its own", (t) =>
  withProject(t, async (root) => {
    await ops.createTask(root, { title: "Base", type: "bug", group: "g1" });
    await ops.createTask(root, { title: "Child", type: "bug", dependencies: ["base.md"] });
    const report = await ops.checkTask(root, "child.md");
    assert.ok(!report.issues.some((i) => i.type === "group_mismatch"));
  }));

// ---------------------------------------------------------------------------
// chains and multi-hop scenarios
// ---------------------------------------------------------------------------

test("a chain of tasks each inheriting from the previous ends up sharing one group", (t) =>
  withProject(t, async (root) => {
    await ops.createTask(root, { title: "Root", type: "bug", group: "g1" });
    await ops.createTask(root, { title: "Mid", type: "bug", dependencies: ["root.md"] });
    const leaf = await ops.createTask(root, { title: "Leaf", type: "bug", dependencies: ["mid.md"] });
    const full = await ops.getTask(root, leaf.path);
    assert.equal(full.frontmatter.group, "g1");
  }));

test("linking two independently-grouped chains together is rejected", (t) =>
  withProject(t, async (root) => {
    await ops.createTask(root, { title: "Root A", type: "bug", group: "ga" });
    await ops.createTask(root, { title: "Mid A", type: "bug", dependencies: ["root-a.md"] });
    await ops.createTask(root, { title: "Root B", type: "bug", group: "gb" });
    await ops.createTask(root, { title: "Mid B", type: "bug", dependencies: ["root-b.md"] });

    await assert.rejects(
      () =>
        ops.createTask(root, {
          title: "Bridge",
          type: "bug",
          dependencies: ["mid-a.md", "mid-b.md"],
        }),
      /different groups/
    );
  }));

test("a group can be shared by many unrelated linked tasks without forcing an explicit id anywhere", (t) =>
  withProject(t, async (root) => {
    await ops.createTask(root, { title: "Seed", type: "bug", group: "epic-1" });
    let last = "seed.md";
    for (let i = 0; i < 5; i += 1) {
      const next = await ops.createTask(root, {
        title: `Step ${i}`,
        type: "bug",
        dependencies: [last],
      });
      last = next.path;
    }
    const full = await ops.getTask(root, last);
    assert.equal(full.frontmatter.group, "epic-1");
  }));

test("resolving a dependency's group works whether the linked task lives in tasks/ or tasks/done/", (t) =>
  withProject(t, async (root) => {
    await ops.createTask(root, { title: "Base", type: "bug", group: "g1" });
    await ops.endTask(root, "base.md");
    const child = await ops.createTask(root, { title: "Child", type: "bug", dependencies: ["done/base.md"] });
    const full = await ops.getTask(root, child.path);
    assert.equal(full.frontmatter.group, "g1");
  }));

// ---------------------------------------------------------------------------
// get_tasks_by_group
// ---------------------------------------------------------------------------

test("get_tasks_by_group returns every task carrying the given group", (t) =>
  withProject(t, async (root) => {
    await ops.createTask(root, { title: "Root", type: "bug", group: "epic-1" });
    await ops.createTask(root, { title: "Step 1", type: "bug", dependencies: ["root.md"] });
    await ops.createTask(root, { title: "Step 2", type: "bug", based_on: ["root.md"] });
    await ops.createTask(root, { title: "Other", type: "bug", group: "epic-2" });
    await ops.createTask(root, { title: "Ungrouped", type: "bug" });

    const results = await ops.getTasksByGroup(root, "epic-1");
    assert.deepEqual(
      results.map((r) => r.path).sort(),
      ["root.md", "step-1.md", "step-2.md"]
    );
    assert.ok(results.every((r) => r.group === "epic-1"));
  }));

test("get_tasks_by_group includes tasks/done/ without an include_done flag", (t) =>
  withProject(t, async (root) => {
    await ops.createTask(root, { title: "Root", type: "bug", group: "epic-1" });
    await ops.createTask(root, { title: "Step", type: "bug", dependencies: ["root.md"] });
    await ops.endTask(root, "root.md");

    const results = await ops.getTasksByGroup(root, "epic-1");
    assert.deepEqual(
      results.map((r) => r.path).sort(),
      ["done/root.md", "step.md"]
    );
  }));

test("get_tasks_by_group returns an empty array for a group with no tasks", (t) =>
  withProject(t, async (root) => {
    await ops.createTask(root, { title: "Solo", type: "bug", group: "g1" });
    const results = await ops.getTasksByGroup(root, "nonexistent-group");
    assert.deepEqual(results, []);
  }));

test("get_tasks_by_group excludes tasks with no group and tasks in other groups", (t) =>
  withProject(t, async (root) => {
    await ops.createTask(root, { title: "Ungrouped", type: "bug" });
    await ops.createTask(root, { title: "Other group", type: "bug", group: "g2" });
    await ops.createTask(root, { title: "Matching", type: "bug", group: "g1" });

    const results = await ops.getTasksByGroup(root, "g1");
    assert.deepEqual(results.map((r) => r.path), ["matching.md"]);
  }));

test("get_tasks_by_group rejects an empty group argument", (t) =>
  withProject(t, async (root) => {
    await assert.rejects(() => ops.getTasksByGroup(root, ""), /group is required/);
    await assert.rejects(() => ops.getTasksByGroup(root, "   "), /group is required/);
  }));

test("get_tasks_by_group is exact-match, not a prefix/substring match", (t) =>
  withProject(t, async (root) => {
    await ops.createTask(root, { title: "A", type: "bug", group: "g1" });
    await ops.createTask(root, { title: "B", type: "bug", group: "g10" });
    const results = await ops.getTasksByGroup(root, "g1");
    assert.deepEqual(results.map((r) => r.path), ["a.md"]);
  }));

// ---------------------------------------------------------------------------
// list_tasks: group filter
// ---------------------------------------------------------------------------

test("list_tasks filters by group and still excludes tasks/done/ by default", (t) =>
  withProject(t, async (root) => {
    await ops.createTask(root, { title: "Root", type: "bug", group: "epic-1" });
    await ops.createTask(root, { title: "Step", type: "bug", dependencies: ["root.md"] });
    await ops.endTask(root, "root.md");

    const withoutDone = await ops.listTasks(root, { group: "epic-1" });
    assert.deepEqual(withoutDone.map((r) => r.path), ["step.md"]);

    const withDone = await ops.listTasks(root, { group: "epic-1", include_done: true });
    assert.deepEqual(
      withDone.map((r) => r.path).sort(),
      ["done/root.md", "step.md"]
    );
  }));

test("list_tasks group filter combines with other filters", (t) =>
  withProject(t, async (root) => {
    await ops.createTask(root, { title: "Root", type: "bug", group: "epic-1", priority: "high" });
    await ops.createTask(root, { title: "Step", type: "bug", group: "epic-1", priority: "low" });
    const results = await ops.listTasks(root, { group: "epic-1", priority: "high" });
    assert.deepEqual(results.map((r) => r.path), ["root.md"]);
  }));
