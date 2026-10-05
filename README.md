# mcp-task

A local MCP server + CLI for managing development tasks as plain Markdown
files. No database, no separate index: each task is a `.md` file under
`.task_manager/tasks/`, identified only by its path — read straight off disk on every
call, so hand-editing a file with any editor is always safe and immediately
visible to the next tool call.

See [`todo-mcp-task-manager.txt`](./todo-mcp-task-manager.txt) for the full
design spec, and [`TASK-MANAGER-example.md`](./TASK-MANAGER-example.md) for a ready-to-copy
set of agent instructions on how to use the tools below correctly.

## Install

Published on npm as [`@elguala/mcp-task`](https://www.npmjs.com/package/@elguala/mcp-task);
`npx` fetches it on demand, no global install needed. You can also point
your client at a local clone (see below).

### Claude Code (CLI)

```bash
claude mcp add task-manager -- npx -y @elguala/mcp-task serve --project /absolute/path/to/your/project
```

### Claude Desktop, Cursor, Windsurf, Cline, and any other MCP client

Add this to the client's MCP config (`claude_desktop_config.json`,
`.cursor/mcp.json`, `.windsurf/mcp.json`, ...):

```json
{
  "mcpServers": {
    "task-manager": {
      "command": "npx",
      "args": ["-y", "@elguala/mcp-task", "serve", "--project", "/absolute/path/to/your/project"]
    }
  }
}
```

`--project` can be omitted if you set the `MCP_TASK_PROJECT_ROOT` environment
variable instead. The project directory needs a `.task_manager/tasks/` folder (created for
you on first `create_task`) and, optionally, a `task-config.yaml` — run
`init-config` (CLI) or the `init_config` tool to create one from
[`task-config-example.yaml`](./task-config-example.yaml), or copy it by hand.

### From a local clone (no network fetch at all)

```bash
git clone https://github.com/elguala9/mcp-task.git
cd mcp-task && npm install && npm run build
```

then point the client straight at the compiled entry point:

```json
{
  "mcpServers": {
    "task-manager": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-task/dist/index.js", "serve", "--project", "/absolute/path/to/your/project"]
    }
  }
}
```

This is the way to go if you're iterating on the server itself — rerun
`npm run build` after each change, no reinstall needed.

### Standalone CLI

Every tool is also a CLI command, useful for scripting or when working
outside an agent:

```bash
npx -y @elguala/mcp-task create-task --project . --title "Fix login bug" --type fix
npx -y @elguala/mcp-task list-tasks --project .
```

Run `npx -y @elguala/mcp-task --help` for the full command list, or
use `node dist/index.js ...` from a local clone.

## API

Every operation is both an MCP tool and a CLI command (`create_task` ↔
`create-task`, ...). All paths are relative to `.task_manager/tasks/`, e.g.
`fix-login-bug.md` or `done/setup-ci.md`. Parameters marked `?` are optional.
A section is addressed by name, or by a `" > "`-joined path when the name
alone is ambiguous, e.g. `Checklist > Fase 2`.

### Tasks

| Tool | Parameters | Description |
| --- | --- | --- |
| `create_task` | `title`, `type`, `priority?`, `status?`, `group?`, `dependencies?`, `based_on?` | Creates a task file with the section skeleton of its type. `status` defaults to `created`, `priority` to the first configured one. Fails on a filename collision. |
| `list_tasks` | `status?`, `type?`, `priority?`, `tag?`, `group?`, `include_done?` | Lists tasks matching the filters. `done/` is excluded unless `include_done` is true. |
| `get_tasks_by_group` | `group` | Every task of a group, `done/` included. |
| `get_task` | `path` | Full frontmatter plus the body as a section tree. |
| `update_task` | `path`, `status?`, `priority?`, `title?`, `tags?`, `group?`, `dependencies?`, `based_on?`, `sections?` | Merges frontmatter fields and/or replaces section contents (`sections` is a list of `{ path, content }`). Moves the file to/from `done/` when the status becomes/leaves `finished`. `type` cannot be changed; pass `group: ""` to clear the group. |
| `change_status` | `path`, `status` | Sets any status defined in `task-config.yaml`. |
| `end_task` | `path` | Sets `finished` and moves the file to `done/`. |
| `move_task` | `path`, `to` | Pure path rename: never touches `status`, fails on a collision, rewrites other tasks' `dependencies` that pointed to the old path. |
| `delete_task` | `path` | Deletes the file. Other tasks' dependencies are left untouched. |

### Sections

| Tool | Parameters | Description |
| --- | --- | --- |
| `get_section` | `path`, `section_path` | One section and its subsections. |
| `update_section` | `path`, `section_path`, `content` | Overwrites one section, leaving the rest of the file untouched. |
| `append_to_section` | `path`, `section_path`, `content` | Appends to the end of a section without rewriting it. |
| `get_task_description` | `type`, `section_path` | The `description` configured in `task-config.yaml` for a type's section, without reading any task. |

### Validation

| Tool | Parameters | Description |
| --- | --- | --- |
| `check_task` | `path` | Validates a task against its type's configured sections. Read-only. |
| `fix_task` | `path` | Additively adds the sections `check_task` reports as missing. Never removes or alters existing content. |

### Groups

| Tool | Parameters | Description |
| --- | --- | --- |
| `get_group_info` | `group` | Reads `.task_manager/groups/<group>.md`, the context shared by all the group's tasks. Created automatically the first time a group is used. |
| `update_group_info` | `group`, `body` | Replaces the whole body of the group's info file. |

### Configuration

| Tool | Parameters | Description |
| --- | --- | --- |
| `get_task_config` | – | The parsed `task-config.yaml` (statuses, priorities, types/sections). |
| `init` | `instructions?`, `force?` | Sets up the project: creates `task-config.yaml`, `.task_manager/tasks/` and `.task_manager/groups/`. Existing files are kept unless `force` is set. `TASK-MANAGER.md` (agent instructions, from [`TASK-MANAGER-example.md`](./TASK-MANAGER-example.md)) is created only when `instructions` is true. CLI: `init [--instructions] [--force]`. |
| `init_config` | `force?` | Creates `task-config.yaml` from the packaged template. Fails with `collision` if it exists, unless `force` is set. |

### Statuses

Only `created` and `finished` are built in. `finished` is terminal: it moves
the file to `done/`. Any other status (`started`, `review`, ...) is custom:
list it in `task-config.yaml` and set it with `change_status`.

Every failure returns `{ ok: false, error: { code, message } }` with a
stable `code` (`not_found`, `collision`, `unknown_status`, `unknown_type`,
`unresolved_dependency`, ...) meant to be branched on programmatically.

## Development

```bash
npm install
npm run build   # compiles src/ -> dist/
npm test        # runs the test suite
npm run dev      # runs the MCP server from source via tsx, for local iteration
```

## License

MIT — see [LICENSE](./LICENSE).
