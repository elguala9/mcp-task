import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as ops from "./operations.js";
import { toStandardError } from "./errors.js";

function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function errorResult(err: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(toStandardError(err), null, 2) }], isError: true };
}

async function guarded<T>(fn: () => Promise<T>) {
  try {
    const result = await fn();
    return json(result);
  } catch (err) {
    return errorResult(err);
  }
}

const sectionUpdateSchema = z.object({
  path: z.string().describe('Section path, e.g. "Checklist" or "Checklist > Fase 2"'),
  content: z.string().describe("New raw markdown content for the section"),
});

export function createServer(projectRoot: string): McpServer {
  const server = new McpServer({ name: "mcp-task-manager", version: "0.1.0" });

  server.registerTool(
    "create_task",
    {
      title: "Create task",
      description: "Creates a new task .md file under tasks/, generating the section skeleton for its type.",
      inputSchema: {
        title: z.string().describe("Human-readable task title, used to derive the filename slug"),
        type: z.string().describe("Task type; determines which sections tree from task-config.yaml is used"),
        priority: z.string().optional().describe("Defaults to the first configured priority"),
        status: z.string().optional().describe('Defaults to "created"'),
        dependencies: z
          .array(z.string())
          .optional()
          .describe("Paths (relative to tasks/) of tasks that must be finished first"),
      },
    },
    async (args) => guarded(() => ops.createTask(projectRoot, args))
  );

  server.registerTool(
    "list_tasks",
    {
      title: "List tasks",
      description: "Lists tasks, optionally filtered by status/type/priority/tag.",
      inputSchema: {
        status: z.string().optional(),
        type: z.string().optional(),
        priority: z.string().optional(),
        tag: z.string().optional(),
        include_done: z.boolean().optional().describe("Include tasks/done/ (default false)"),
      },
    },
    async (args) => guarded(() => ops.listTasks(projectRoot, args))
  );

  server.registerTool(
    "get_task",
    {
      title: "Get task",
      description: "Returns a task's full frontmatter plus its body as a section tree.",
      inputSchema: { path: z.string().describe('Path relative to tasks/, e.g. "fix-login-bug.md" or "done/x.md"') },
    },
    async ({ path }) => guarded(() => ops.getTask(projectRoot, path))
  );

  server.registerTool(
    "get_section",
    {
      title: "Get section",
      description: "Returns a single section (and its subsections) of a task, addressed by a ' > '-separated path.",
      inputSchema: {
        path: z.string(),
        section_path: z.string().describe('e.g. "Checklist" or "Checklist > Fase 2"'),
      },
    },
    async ({ path, section_path }) => guarded(() => ops.getSection(projectRoot, path, section_path))
  );

  server.registerTool(
    "get_task_description",
    {
      title: "Get task description",
      description:
        "Returns the optional \"description\" configured in task-config.yaml for a given type's section, without reading any task file.",
      inputSchema: {
        type: z.string().describe("Task type, as defined in task-config.yaml"),
        section_path: z.string().describe('e.g. "Checklist" or "Checklist > Fase 2"'),
      },
    },
    async ({ type, section_path }) => guarded(() => ops.getTaskDescription(projectRoot, type, section_path))
  );

  server.registerTool(
    "check_task",
    {
      title: "Check task",
      description: "Validates a task against its type's configured section structure. Read-only.",
      inputSchema: { path: z.string() },
    },
    async ({ path }) => guarded(() => ops.checkTask(projectRoot, path))
  );

  server.registerTool(
    "fix_task",
    {
      title: "Fix task",
      description: "Additively fixes missing sections found by check_task. Never removes or alters existing content.",
      inputSchema: { path: z.string() },
    },
    async ({ path }) => guarded(() => ops.fixTask(projectRoot, path))
  );

  server.registerTool(
    "update_task",
    {
      title: "Update task",
      description:
        "Merges frontmatter fields and/or replaces section contents. Moves the file to/from tasks/done/ when status becomes/leaves 'finished'. The 'type' field cannot be changed.",
      inputSchema: {
        path: z.string(),
        status: z.string().optional(),
        priority: z.string().optional(),
        title: z.string().optional(),
        tags: z.array(z.string()).optional(),
        dependencies: z.array(z.string()).optional(),
        sections: z.array(sectionUpdateSchema).optional(),
      },
    },
    async ({ path, sections, ...frontmatter }) =>
      guarded(() => ops.updateTask(projectRoot, path, { frontmatter, sections }))
  );

  server.registerTool(
    "update_section",
    {
      title: "Update section",
      description: "Overwrites the full content of one section/subsection, leaving the rest of the file untouched.",
      inputSchema: { path: z.string(), section_path: z.string(), content: z.string() },
    },
    async ({ path, section_path, content }) => guarded(() => ops.updateSection(projectRoot, path, section_path, content))
  );

  server.registerTool(
    "append_to_section",
    {
      title: "Append to section",
      description: "Appends content to the end of a section/subsection without rewriting the rest of it.",
      inputSchema: { path: z.string(), section_path: z.string(), content: z.string() },
    },
    async ({ path, section_path, content }) =>
      guarded(() => ops.appendToSection(projectRoot, path, section_path, content))
  );

  server.registerTool(
    "delete_task",
    {
      title: "Delete task",
      description: "Deletes a task .md file (from tasks/ or tasks/done/). Does not fix up other tasks' dependencies.",
      inputSchema: { path: z.string() },
    },
    async ({ path }) => guarded(async () => (await ops.deleteTask(projectRoot, path), { deleted: path }))
  );

  server.registerTool(
    "move_task",
    {
      title: "Move task",
      description:
        "Moves a task .md file from one path to another (relative to tasks/, e.g. into/out of done/). Pure path rename: never touches status, never renames based on title, and fails on a destination collision. Rewrites the 'dependencies' list of every other task that referenced the old path.",
      inputSchema: { path: z.string(), to: z.string().describe("Destination path, relative to tasks/") },
    },
    async ({ path, to }) => guarded(() => ops.moveTask(projectRoot, path, to))
  );

  server.registerTool(
    "init_config",
    {
      title: "Init config",
      description:
        "Creates task-config.yaml from the packaged example template if it doesn't already exist. Fails with 'collision' if it exists, unless force is set.",
      inputSchema: { force: z.boolean().optional().describe("Overwrite an existing task-config.yaml") },
    },
    async ({ force }) => guarded(() => ops.initConfig(projectRoot, { force }))
  );

  server.registerTool(
    "get_task_config",
    {
      title: "Get task config",
      description: "Returns the general task-config.yaml configuration (statuses, priorities, types/sections).",
      inputSchema: {},
    },
    async () => guarded(() => ops.getTaskConfig(projectRoot))
  );

  server.registerTool(
    "start_task",
    { title: "Start task", description: 'Shortcut for update_task setting status to "started".', inputSchema: { path: z.string() } },
    async ({ path }) => guarded(() => ops.startTask(projectRoot, path))
  );

  server.registerTool(
    "test_task",
    { title: "Test task", description: 'Shortcut for update_task setting status to "tested".', inputSchema: { path: z.string() } },
    async ({ path }) => guarded(() => ops.testTask(projectRoot, path))
  );

  server.registerTool(
    "deploy_task",
    { title: "Deploy task", description: 'Shortcut for update_task setting status to "deployed".', inputSchema: { path: z.string() } },
    async ({ path }) => guarded(() => ops.deployTask(projectRoot, path))
  );

  server.registerTool(
    "end_task",
    {
      title: "End task",
      description: 'Shortcut for update_task setting status to "finished" (moves the file to tasks/done/).',
      inputSchema: { path: z.string() },
    },
    async ({ path }) => guarded(() => ops.endTask(projectRoot, path))
  );

  server.registerTool(
    "change_status",
    {
      title: "Change status",
      description: "Sets a task's status to any status defined in task-config.yaml (reserved or custom).",
      inputSchema: { path: z.string(), status: z.string() },
    },
    async ({ path, status }) => guarded(() => ops.changeStatus(projectRoot, path, status))
  );

  return server;
}

export async function runStdioServer(projectRoot: string): Promise<void> {
  const server = createServer(projectRoot);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
