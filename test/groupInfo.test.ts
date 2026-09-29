import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
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

const infoPath = (root: string, group: string) => path.join(root, "groups", `${group}.md`);

test("create_task with a new group creates groups/<group>.md", (t) =>
  withProject(t, async (root) => {
    await ops.createTask(root, { title: "A", type: "bug", group: "epic-1" });
    const info = await ops.getGroupInfo(root, "epic-1");
    assert.equal(info.group, "epic-1");
    assert.equal(info.path, "groups/epic-1.md");
    assert.match(info.body, /## Overview/);
  }));

test("group info file is not created for tasks without a group", (t) =>
  withProject(t, async (root) => {
    await ops.createTask(root, { title: "A", type: "bug" });
    await assert.rejects(fs.access(path.join(root, "groups")));
  }));

test("group info file is not listed as a task", (t) =>
  withProject(t, async (root) => {
    await ops.createTask(root, { title: "A", type: "bug", group: "g1" });
    const tasks = await ops.listTasks(root, { include_done: true });
    assert.equal(tasks.length, 1);
  }));

test("an existing group info file is never overwritten by later tasks", (t) =>
  withProject(t, async (root) => {
    await ops.createTask(root, { title: "A", type: "bug", group: "g1" });
    await ops.updateGroupInfo(root, "g1", "Shared notes");
    await ops.createTask(root, { title: "B", type: "bug", group: "g1" });
    assert.equal((await ops.getGroupInfo(root, "g1")).body.trim(), "Shared notes");
  }));

test("an inherited group also has its info file", (t) =>
  withProject(t, async (root) => {
    const a = await ops.createTask(root, { title: "A", type: "bug", group: "g1" });
    await fs.rm(infoPath(root, "g1"));
    await ops.createTask(root, { title: "B", type: "bug", dependencies: [a.path] });
    assert.equal((await ops.getGroupInfo(root, "g1")).group, "g1");
  }));

test("update_task setting a group creates its info file", (t) =>
  withProject(t, async (root) => {
    const a = await ops.createTask(root, { title: "A", type: "bug" });
    await ops.updateTask(root, a.path, { frontmatter: { group: "g2" } });
    assert.equal((await ops.getGroupInfo(root, "g2")).group, "g2");
  }));

test("update_group_info replaces the body and keeps created_at", (t) =>
  withProject(t, async (root) => {
    await ops.createTask(root, { title: "A", type: "bug", group: "g1" });
    const before = await ops.getGroupInfo(root, "g1");
    const after = await ops.updateGroupInfo(root, "g1", "## Overview\n\nNew text");
    assert.equal(after.body.trim(), "## Overview\n\nNew text");
    assert.equal(after.created_at, before.created_at);
  }));

test("get_group_info on an unknown group is not_found", (t) =>
  withProject(t, async (root) => {
    await assert.rejects(ops.getGroupInfo(root, "nope"), { code: "not_found" });
  }));

test("group ids that are not filename-safe are rejected", (t) =>
  withProject(t, async (root) => {
    for (const bad of ["../x", "a/b", "a b", ".hidden"]) {
      await assert.rejects(ops.createTask(root, { title: "A", type: "bug", group: bad }), { code: "invalid_input" });
    }
    const a = await ops.createTask(root, { title: "B", type: "bug" });
    await assert.rejects(ops.updateTask(root, a.path, { frontmatter: { group: "a/b" } }), { code: "invalid_input" });
    await assert.rejects(ops.getGroupInfo(root, "../x"), { code: "invalid_input" });
  }));

test("a rejected group conflict does not create an info file", (t) =>
  withProject(t, async (root) => {
    const a = await ops.createTask(root, { title: "A", type: "bug", group: "g1" });
    await assert.rejects(
      ops.createTask(root, { title: "B", type: "bug", group: "g2", dependencies: [a.path] }),
      { code: "group_conflict" }
    );
    await assert.rejects(fs.access(infoPath(root, "g2")));
  }));
