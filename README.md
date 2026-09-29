# mcp-task

A local MCP server + CLI for managing development tasks as plain Markdown
files. No database, no separate index: each task is a `.md` file under
`.task_manager/tasks/`, identified only by its path — read straight off disk on every
call, so hand-editing a file with any editor is always safe and immediately
visible to the next tool call.

See [`todo-mcp-task-manager.txt`](./todo-mcp-task-manager.txt) for the full
design spec, and [`CLAUDE-example.md`](./CLAUDE-example.md) for a ready-to-copy
set of agent instructions on how to use the tools below correctly.

## Install

Not published to the npm registry — install straight from this GitHub repo,
or point your client at a local clone. Either way `npx` builds it on the fly
(via the `prepare` script) the first time it's fetched.

### Claude Code (CLI)

```bash
claude mcp add task-manager -- npx -y github:elguala9/mcp-task serve --project /absolute/path/to/your/project
```

### Claude Desktop, Cursor, Windsurf, Cline, and any other MCP client

Add this to the client's MCP config (`claude_desktop_config.json`,
`.cursor/mcp.json`, `.windsurf/mcp.json`, ...):

```json
{
  "mcpServers": {
    "task-manager": {
      "command": "npx",
      "args": ["-y", "github:elguala9/mcp-task", "serve", "--project", "/absolute/path/to/your/project"]
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
npx -y github:elguala9/mcp-task create-task --project . --title "Fix login bug" --type fix
npx -y github:elguala9/mcp-task list-tasks --project .
```

Run `npx -y github:elguala9/mcp-task --help` for the full command list, or
use `node dist/index.js ...` from a local clone.

## Tools

`create_task`, `list_tasks`, `get_task`, `get_section`,
`get_task_description`, `get_task_config`, `init_config`, `check_task`,
`fix_task`, `update_task`, `update_section`, `append_to_section`,
`delete_task`, `move_task`, `start_task`, `test_task`, `deploy_task`,
`end_task`, `change_status`.

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
