import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as ops from "../src/operations.js";
import { makeProject, cleanup, SAMPLE_CONFIG, readRawFile, fileExistsAt } from "./testUtils.js";

async function withProject(t: TestContext, fn: (root: string) => Promise<void>): Promise<void> {
  const root = await makeProject(t.name, SAMPLE_CONFIG);
  try {
    await fn(root);
  } finally {
    await cleanup(root);
  }
}

test("create_task generates the section skeleton for its type", (t) =>
  withProject(t, async (root) => {
    const summary = await ops.createTask(root, { title: "Add dark mode", type: "feature" });
    assert.equal(summary.path, "add-dark-mode.md");
    assert.equal(summary.status, "created");
    assert.equal(summary.priority, "low"); // first configured priority is the default

    const task = await ops.getTask(root, "add-dark-mode.md");
    const names = task.sections.map((s) => s.name);
    assert.deepEqual(names, ["Descrizione", "Note", "Checklist"]);
    assert.equal(task.sections[0].children[0].name, "Sottosezione1");
  }));

test("create_task with sections:[] produces a free-form empty body", (t) =>
  withProject(t, async (root) => {
    await ops.createTask(root, { title: "Weird crash", type: "bug" });
    const task = await ops.getTask(root, "weird-crash.md");
    assert.deepEqual(task.sections, []);
  }));

test("create_task rejects filename collisions", (t) =>
  withProject(t, async (root) => {
    await ops.createTask(root, { title: "Fix login bug", type: "fix" });
    await assert.rejects(() => ops.createTask(root, { title: "Fix login bug", type: "fix" }), /already exists/);
  }));

test("create_task rejects a collision against a task already in tasks/done/", (t) =>
  withProject(t, async (root) => {
    await ops.createTask(root, { title: "Setup CI", type: "fix" });
    await ops.endTask(root, "setup-ci.md");
    assert.ok(await fileExistsAt(root, "done/setup-ci.md"));
    await assert.rejects(() => ops.createTask(root, { title: "Setup CI", type: "fix" }), /already exists/);
  }));

test("create_task validates dependencies exist", (t) =>
  withProject(t, async (root) => {
    await assert.rejects(
      () => ops.createTask(root, { title: "Blocked", type: "bug", dependencies: ["ghost.md"] }),
      /does not point to an existing task/
    );
  }));

test("create_task rejects unknown status/priority", (t) =>
  withProject(t, async (root) => {
    await assert.rejects(
      () => ops.createTask(root, { title: "X", type: "bug", status: "bogus" }),
      /Unknown status/
    );
    await assert.rejects(
      () => ops.createTask(root, { title: "Y", type: "bug", priority: "urgentissimo" }),
      /Unknown priority/
    );
  }));

test("list_tasks filters by status/type/priority/tag and excludes done/ by default", (t) =>
  withProject(t, async (root) => {
    await ops.createTask(root, { title: "A feature", type: "feature", priority: "high" });
    await ops.createTask(root, { title: "A fix", type: "fix", priority: "low" });
    await ops.endTask(root, "a-fix.md");

    const onlyActive = await ops.listTasks(root);
    assert.equal(onlyActive.length, 1);
    assert.equal(onlyActive[0].path, "a-feature.md");

    const withDone = await ops.listTasks(root, { include_done: true });
    assert.equal(withDone.length, 2);

    const byType = await ops.listTasks(root, { type: "feature", include_done: true });
    assert.equal(byType.length, 1);
    assert.equal(byType[0].path, "a-feature.md");
  }));

test("get_section returns a single section as a tree", (t) =>
  withProject(t, async (root) => {
    await ops.createTask(root, { title: "Add dark mode", type: "feature" });
    await ops.appendToSection(root, "add-dark-mode.md", "Checklist", "- [ ] primo punto");
    const section = await ops.getSection(root, "add-dark-mode.md", "Checklist");
    assert.equal(section.name, "Checklist");
    assert.equal(section.children[0].name, "primo punto");
  }));

test("check_task reports missing sections but not empty ones", (t) =>
  withProject(t, async (root) => {
    await ops.createTask(root, { title: "Add dark mode", type: "feature" });
    const report = await ops.checkTask(root, "add-dark-mode.md");
    assert.equal(report.ok, true);
    assert.deepEqual(report.issues, []);
  }));

test("check_task detects a section removed by hand, and fix_task restores it additively", (t) =>
  withProject(t, async (root) => {
    await ops.createTask(root, { title: "Add dark mode", type: "feature" });
    const raw = await readRawFile(root, "add-dark-mode.md");
    const withoutNote = raw.replace(/## Note\n\n/, "");
    const { promises: fs } = await import("node:fs");
    const path = await import("node:path");
    await fs.writeFile(path.join(root, "tasks", "add-dark-mode.md"), withoutNote, "utf8");

    const report = await ops.checkTask(root, "add-dark-mode.md");
    assert.equal(report.ok, false);
    assert.equal(report.issues[0].type, "missing_section");
    assert.match(report.issues[0].message, /Note/);

    const fixResult = await ops.fixTask(root, "add-dark-mode.md");
    assert.equal(fixResult.fixed, true);

    const after = await ops.checkTask(root, "add-dark-mode.md");
    assert.equal(after.ok, true);
    const task = await ops.getTask(root, "add-dark-mode.md");
    assert.ok(task.sections.some((s) => s.name === "Note"));
  }));

test("check_task flags unrecognized status/priority and broken dependencies", (t) =>
  withProject(t, async (root) => {
    await ops.createTask(root, { title: "Ghosted", type: "bug", dependencies: [] });
    // simulate drift: hand-edit frontmatter to reference a status/dependency no longer valid
    const { promises: fs } = await import("node:fs");
    const path = await import("node:path");
    const file = path.join(root, "tasks", "ghosted.md");
    let raw = await fs.readFile(file, "utf8");
    raw = raw.replace("status: created", "status: archived").replace(
      "type: bug\n",
      "type: bug\ndependencies:\n  - nonexistent.md\n"
    );
    await fs.writeFile(file, raw, "utf8");

    const report = await ops.checkTask(root, "ghosted.md");
    const types = report.issues.map((i) => i.type).sort();
    assert.deepEqual(types, ["broken_dependency", "unrecognized_status"]);
  }));

test("fix_task refuses to touch a file with non-additive issues", (t) =>
  withProject(t, async (root) => {
    await ops.createTask(root, { title: "Ghosted", type: "bug" });
    const { promises: fs } = await import("node:fs");
    const path = await import("node:path");
    const file = path.join(root, "tasks", "ghosted.md");
    let raw = await fs.readFile(file, "utf8");
    raw = raw.replace("status: created", "status: archived");
    await fs.writeFile(file, raw, "utf8");

    const before = raw;
    const result = await ops.fixTask(root, "ghosted.md");
    assert.equal(result.fixed, false);
    assert.match(result.message, /manual intervention/);
    const after = await fs.readFile(file, "utf8");
    assert.equal(after, before);
  }));

test("update_task merges frontmatter, updates updated_at, and rejects type changes", (t) =>
  withProject(t, async (root) => {
    const created = await ops.createTask(root, { title: "Add dark mode", type: "feature" });
    const before = await ops.getTask(root, created.path);

    const updated = await ops.updateTask(root, created.path, { frontmatter: { priority: "high" } });
    assert.equal(updated.frontmatter.priority, "high");
    assert.equal(updated.frontmatter.title, "Add dark mode");
    assert.notEqual(updated.frontmatter.updated_at, before.frontmatter.updated_at);

    await assert.rejects(
      () => ops.updateTask(root, created.path, { frontmatter: { type: "bug" } as any }),
      /cannot be changed/
    );
  }));

test("update_task moves the file to tasks/done/ when status becomes finished, and back when reopened", (t) =>
  withProject(t, async (root) => {
    await ops.createTask(root, { title: "Setup CI", type: "fix" });
    assert.ok(await fileExistsAt(root, "setup-ci.md"));

    const finished = await ops.updateTask(root, "setup-ci.md", { frontmatter: { status: "finished" } });
    assert.equal(finished.path, "done/setup-ci.md");
    assert.ok(await fileExistsAt(root, "done/setup-ci.md"));
    assert.ok(!(await fileExistsAt(root, "setup-ci.md")));

    const reopened = await ops.updateTask(root, "done/setup-ci.md", { frontmatter: { status: "started" } });
    assert.equal(reopened.path, "setup-ci.md");
    assert.ok(await fileExistsAt(root, "setup-ci.md"));
    assert.ok(!(await fileExistsAt(root, "done/setup-ci.md")));
  }));

test("update_task also applies section replacements in the same call", (t) =>
  withProject(t, async (root) => {
    await ops.createTask(root, { title: "Add dark mode", type: "feature" });
    const updated = await ops.updateTask(root, "add-dark-mode.md", {
      sections: [{ path: "Note", content: "nota aggiornata" }],
    });
    const note = updated.sections.find((s) => s.name === "Note")!;
    assert.equal(note.content, "nota aggiornata");
  }));

test("update_section overwrites only the target section", (t) =>
  withProject(t, async (root) => {
    await ops.createTask(root, { title: "Add dark mode", type: "feature" });
    await ops.appendToSection(root, "add-dark-mode.md", "Note", "vecchia nota");
    await ops.updateSection(root, "add-dark-mode.md", "Note", "nuova nota");
    const task = await ops.getTask(root, "add-dark-mode.md");
    const note = task.sections.find((s) => s.name === "Note")!;
    assert.equal(note.content, "nuova nota");
  }));

test("append_to_section adds a nested checklist item without disturbing siblings", (t) =>
  withProject(t, async (root) => {
    await ops.createTask(root, { title: "Add dark mode", type: "feature" });
    await ops.appendToSection(root, "add-dark-mode.md", "Checklist", "- [ ] primo punto");
    await ops.appendToSection(root, "add-dark-mode.md", "Checklist", "- [ ] secondo punto");
    await ops.appendToSection(root, "add-dark-mode.md", "Checklist > secondo punto", "  - [ ] sotto-punto");

    const task = await ops.getTask(root, "add-dark-mode.md");
    const checklist = task.sections.find((s) => s.name === "Checklist")!;
    assert.equal(checklist.children.length, 2);
    assert.equal(checklist.children[1].children[0].name, "sotto-punto");
  }));

test("delete_task removes the file from tasks/ or tasks/done/", (t) =>
  withProject(t, async (root) => {
    await ops.createTask(root, { title: "Setup CI", type: "fix" });
    await ops.deleteTask(root, "setup-ci.md");
    assert.ok(!(await fileExistsAt(root, "setup-ci.md")));
    await assert.rejects(() => ops.getTask(root, "setup-ci.md"), /not found/);
  }));

test("get_next_task picks highest priority among unblocked 'created' tasks, oldest wins ties", (t) =>
  withProject(t, async (root) => {
    await ops.createTask(root, { title: "Low one", type: "bug", priority: "low" });
    await ops.createTask(root, { title: "High one", type: "bug", priority: "high" });
    await ops.createTask(root, { title: "Critical blocked", type: "bug", priority: "critical", dependencies: ["low-one.md"] });

    const next = await ops.getNextTask(root);
    assert.equal(next?.path, "high-one.md"); // critical is blocked, so high wins
  }));

test("get_next_task excludes tasks whose dependency is not finished, includes once it is", (t) =>
  withProject(t, async (root) => {
    await ops.createTask(root, { title: "Setup CI", type: "fix", priority: "critical" });
    await ops.createTask(root, { title: "Refactor API", type: "feature", priority: "high", dependencies: ["setup-ci.md"] });

    const first = await ops.getNextTask(root);
    assert.equal(first?.path, "setup-ci.md");

    await ops.endTask(root, "setup-ci.md");
    const second = await ops.getNextTask(root);
    assert.equal(second?.path, "refactor-api.md");
  }));

test("get_next_task dependency resolution follows a task into tasks/done/", (t) =>
  withProject(t, async (root) => {
    await ops.createTask(root, { title: "Setup CI", type: "fix" });
    await ops.endTask(root, "setup-ci.md");
    await ops.createTask(root, { title: "Refactor API", type: "feature", dependencies: ["setup-ci.md"] });

    const next = await ops.getNextTask(root);
    assert.equal(next?.path, "refactor-api.md");
  }));

test("status shortcuts set the expected reserved status", (t) =>
  withProject(t, async (root) => {
    await ops.createTask(root, { title: "Add dark mode", type: "feature" });
    assert.equal((await ops.startTask(root, "add-dark-mode.md")).frontmatter.status, "started");
    assert.equal((await ops.testTask(root, "add-dark-mode.md")).frontmatter.status, "tested");
    assert.equal((await ops.deployTask(root, "add-dark-mode.md")).frontmatter.status, "deployed");
    const ended = await ops.endTask(root, "add-dark-mode.md");
    assert.equal(ended.frontmatter.status, "finished");
    assert.equal(ended.path, "done/add-dark-mode.md");
  }));

test("change_status accepts a custom configured status and rejects unknown ones", (t) =>
  withProject(t, async (root) => {
    await ops.createTask(root, { title: "Add dark mode", type: "feature" });
    const reviewed = await ops.changeStatus(root, "add-dark-mode.md", "review");
    assert.equal(reviewed.frontmatter.status, "review");
    await assert.rejects(() => ops.changeStatus(root, "add-dark-mode.md", "bogus"), /Unknown status/);
  }));

test("get_task_description resolves nested and shorthand section paths from config only", (t) =>
  withProject(t, async (root) => {
    const withDesc = await ops.getTaskDescription(root, "feature", "Descrizione");
    assert.equal(withDesc.description, "Spiega cosa va implementato");

    const noDesc = await ops.getTaskDescription(root, "feature", "Note");
    assert.equal(noDesc.description, null);

    await assert.rejects(() => ops.getTaskDescription(root, "feature", "Bogus"), /is not defined/);
  }));

test("a realistic backlog of many tasks: filters, dependency chains and priority tie-breaks", (t) =>
  withProject(t, async (root) => {
    // Two prerequisites, finished right away so later tasks can depend on them.
    await ops.createTask(root, { title: "Setup CI", type: "fix", priority: "critical" });
    await ops.createTask(root, { title: "Setup logging", type: "fix", priority: "high" });

    await ops.createTask(root, { title: "Fix login bug", type: "fix", priority: "high", dependencies: ["setup-ci.md"] });
    await ops.createTask(root, { title: "Fix signup bug", type: "fix", priority: "medium" });
    await ops.createTask(root, { title: "Add dark mode", type: "feature", priority: "medium" });
    await ops.createTask(root, {
      title: "Add notifications",
      type: "feature",
      priority: "high",
      dependencies: ["setup-logging.md"],
    });
    await ops.createTask(root, { title: "Add search", type: "feature", priority: "low" });
    await ops.createTask(root, {
      title: "Refactor API",
      type: "feature",
      priority: "critical",
      dependencies: ["fix-login-bug.md"],
    });
    await ops.createTask(root, { title: "Refactor DB layer", type: "feature", priority: "critical" });
    await ops.createTask(root, { title: "Investigate crash A", type: "bug", priority: "high" });
    await ops.createTask(root, { title: "Investigate crash B", type: "bug", priority: "medium" });
    await ops.createTask(root, { title: "Write docs", type: "feature", priority: "low" });
    await ops.createTask(root, { title: "Update dependencies", type: "fix", priority: "medium" });

    await ops.updateTask(root, "write-docs.md", { frontmatter: { tags: ["docs"] } });
    await ops.updateTask(root, "update-dependencies.md", { frontmatter: { tags: ["chore"] } });
    await ops.startTask(root, "investigate-crash-a.md");

    await ops.endTask(root, "setup-ci.md");
    await ops.endTask(root, "setup-logging.md");

    const all = await ops.listTasks(root, { include_done: true });
    assert.equal(all.length, 13);
    assert.equal((await ops.listTasks(root)).length, 11); // done/ excluded by default

    const features = await ops.listTasks(root, { type: "feature", include_done: true });
    assert.equal(features.length, 6);

    const started = await ops.listTasks(root, { status: "started" });
    assert.deepEqual(started.map((s) => s.path), ["investigate-crash-a.md"]);

    const docsTagged = await ops.listTasks(root, { tag: "docs" });
    assert.deepEqual(docsTagged.map((s) => s.path), ["write-docs.md"]);
    const choreTagged = await ops.listTasks(root, { tag: "chore" });
    assert.deepEqual(choreTagged.map((s) => s.path), ["update-dependencies.md"]);

    // "Refactor API" is critical but blocked on "Fix login bug" (not finished yet),
    // so "Refactor DB layer" (also critical, unblocked) wins on priority alone.
    const next1 = await ops.getNextTask(root);
    assert.equal(next1?.path, "refactor-db-layer.md");

    for (const path of ["fix-login-bug.md", "add-notifications.md", "refactor-db-layer.md"]) {
      const report = await ops.checkTask(root, path);
      assert.equal(report.ok, true, `expected ${path} to be valid, got issues: ${JSON.stringify(report.issues)}`);
    }

    // Once "Fix login bug" finishes, "Refactor API" becomes unblocked too; tied on
    // critical priority with "Refactor DB layer", the older task wins the tie-break.
    await ops.endTask(root, "fix-login-bug.md");
    const next2 = await ops.getNextTask(root);
    assert.equal(next2?.path, "refactor-api.md");
  }));
