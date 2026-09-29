import { Command } from "commander";
import * as ops from "./operations.js";
import { toStandardError } from "./errors.js";

function print(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

function fail(err: unknown): never {
  console.error(JSON.stringify(toStandardError(err), null, 2));
  process.exit(1);
}

function list(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function buildCli(projectRoot: string): Command {
  const program = new Command();
  program.name("mcp-task-manager").description("Markdown-based development task manager").version("0.1.0");

  program
    .command("create-task")
    .requiredOption("--title <title>", "task title")
    .requiredOption("--type <type>", "task type")
    .option("--priority <priority>")
    .option("--status <status>")
    .option("--group <group>", "group id; tasks linked by dependencies/based_on must share one")
    .option("--dependencies <paths>", "comma-separated list of dependency paths")
    .option("--based-on <paths>", "comma-separated list of paths this task is derived from")
    .action(async (opts) => {
      try {
        print(
          await ops.createTask(projectRoot, {
            title: opts.title,
            type: opts.type,
            priority: opts.priority,
            status: opts.status,
            group: opts.group,
            dependencies: list(opts.dependencies),
            based_on: list(opts.basedOn),
          })
        );
      } catch (err) {
        fail(err);
      }
    });

  program
    .command("list-tasks")
    .option("--status <status>")
    .option("--type <type>")
    .option("--priority <priority>")
    .option("--tag <tag>")
    .option("--group <group>")
    .option("--include-done", "also list .task_manager/tasks/done/", false)
    .action(async (opts) => {
      try {
        print(
          await ops.listTasks(projectRoot, {
            status: opts.status,
            type: opts.type,
            priority: opts.priority,
            tag: opts.tag,
            group: opts.group,
            include_done: opts.includeDone,
          })
        );
      } catch (err) {
        fail(err);
      }
    });

  program
    .command("get-tasks-by-group <group>")
    .action(async (group) => {
      try {
        print(await ops.getTasksByGroup(projectRoot, group));
      } catch (err) {
        fail(err);
      }
    });

  program
    .command("get-group-info <group>")
    .action(async (group) => {
      try {
        print(await ops.getGroupInfo(projectRoot, group));
      } catch (err) {
        fail(err);
      }
    });

  program
    .command("update-group-info <group> <body>")
    .action(async (group, body) => {
      try {
        print(await ops.updateGroupInfo(projectRoot, group, body));
      } catch (err) {
        fail(err);
      }
    });

  program
    .command("get-task <path>")
    .action(async (path) => {
      try {
        print(await ops.getTask(projectRoot, path));
      } catch (err) {
        fail(err);
      }
    });

  program
    .command("get-section <path> <sectionPath>")
    .action(async (path, sectionPath) => {
      try {
        print(await ops.getSection(projectRoot, path, sectionPath));
      } catch (err) {
        fail(err);
      }
    });

  program
    .command("get-task-description <type> <sectionPath>")
    .action(async (type, sectionPath) => {
      try {
        print(await ops.getTaskDescription(projectRoot, type, sectionPath));
      } catch (err) {
        fail(err);
      }
    });

  program
    .command("check-task <path>")
    .action(async (path) => {
      try {
        print(await ops.checkTask(projectRoot, path));
      } catch (err) {
        fail(err);
      }
    });

  program
    .command("fix-task <path>")
    .action(async (path) => {
      try {
        print(await ops.fixTask(projectRoot, path));
      } catch (err) {
        fail(err);
      }
    });

  program
    .command("update-task <path>")
    .option("--title <title>")
    .option("--status <status>")
    .option("--priority <priority>")
    .option("--tags <tags>", "comma-separated")
    .option("--group <group>", 'group id; pass "" to clear it')
    .option("--dependencies <paths>", "comma-separated")
    .option("--based-on <paths>", "comma-separated")
    .action(async (path, opts) => {
      try {
        print(
          await ops.updateTask(projectRoot, path, {
            frontmatter: {
              title: opts.title,
              status: opts.status,
              priority: opts.priority,
              tags: list(opts.tags),
              group: opts.group,
              dependencies: list(opts.dependencies),
              based_on: list(opts.basedOn),
            },
          })
        );
      } catch (err) {
        fail(err);
      }
    });

  program
    .command("update-section <path> <sectionPath> <content>")
    .action(async (path, sectionPath, content) => {
      try {
        print(await ops.updateSection(projectRoot, path, sectionPath, content));
      } catch (err) {
        fail(err);
      }
    });

  program
    .command("append-to-section <path> <sectionPath> <content>")
    .action(async (path, sectionPath, content) => {
      try {
        print(await ops.appendToSection(projectRoot, path, sectionPath, content));
      } catch (err) {
        fail(err);
      }
    });

  program
    .command("delete-task <path>")
    .action(async (path) => {
      try {
        await ops.deleteTask(projectRoot, path);
        print({ deleted: path });
      } catch (err) {
        fail(err);
      }
    });

  program
    .command("move-task <path> <to>")
    .action(async (path, to) => {
      try {
        print(await ops.moveTask(projectRoot, path, to));
      } catch (err) {
        fail(err);
      }
    });

  program
    .command("init-config")
    .option("--force", "overwrite an existing task-config.yaml", false)
    .action(async (opts) => {
      try {
        print(await ops.initConfig(projectRoot, { force: opts.force }));
      } catch (err) {
        fail(err);
      }
    });

  program
    .command("get-task-config")
    .action(async () => {
      try {
        print(await ops.getTaskConfig(projectRoot));
      } catch (err) {
        fail(err);
      }
    });

  program
    .command("start-task <path>")
    .action(async (path) => {
      try {
        print(await ops.startTask(projectRoot, path));
      } catch (err) {
        fail(err);
      }
    });

  program
    .command("test-task <path>")
    .action(async (path) => {
      try {
        print(await ops.testTask(projectRoot, path));
      } catch (err) {
        fail(err);
      }
    });

  program
    .command("deploy-task <path>")
    .action(async (path) => {
      try {
        print(await ops.deployTask(projectRoot, path));
      } catch (err) {
        fail(err);
      }
    });

  program
    .command("end-task <path>")
    .action(async (path) => {
      try {
        print(await ops.endTask(projectRoot, path));
      } catch (err) {
        fail(err);
      }
    });

  program
    .command("change-status <path> <status>")
    .action(async (path, status) => {
      try {
        print(await ops.changeStatus(projectRoot, path, status));
      } catch (err) {
        fail(err);
      }
    });

  return program;
}
