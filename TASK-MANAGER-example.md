# Task manager — instructions for the AI agent (example, replace with your own)

This project's development tasks are managed by an MCP server (this repo)
that exposes tools over `.task_manager/tasks/*.md` files. There is no database and no
separate index: each task is a single Markdown file, identified only by
its path relative to `.task_manager/tasks/`. If a human edits a file by hand, the next
tool call sees the change immediately — nothing is cached.

Use the MCP tools below instead of reading/editing `.task_manager/tasks/**/*.md`
directly with your own file tools: they enforce the section structure
defined in `task-config.yaml`, validate status/priority values, keep
`updated_at` correct, and move files to/from `.task_manager/tasks/done/` consistently.

## Before doing anything: know the config

Call `get_task_config` first (or whenever unsure) to see the currently
valid `statuses`, `priorities`, and the section structure required per
`type`. Don't assume — a project can rename/add custom statuses and
sections at any time in `task-config.yaml`.

## Picking work

1. `list_tasks` with `status: "created"` to see unstarted work (add
   `type`/`priority`/`tag` filters as needed). `include_done: true` also
   pulls in `.task_manager/tasks/done/`, which is excluded by default.
2. For a candidate task, `get_task` to read it in full, and check its
   `dependencies` field: every path listed there must itself have
   `status: "finished"` before you start (check with `get_task` on each
   dependency — it can be located either in `.task_manager/tasks/` or `.task_manager/tasks/done/`)
   before you start work on it. Nothing in the server blocks you from
   starting a blocked task anyway — this is a convention you must apply
   yourself, not an enforced rule.
3. Prefer higher priority first, and among equal priority prefer the
   older `created_at`.

## Working a task

- When you begin, optionally `change_status` to a custom in-progress status if your
  `task-config.yaml` defines one (the only built-in statuses are `created` and `finished`).
- Read/update its sections with `get_section`, `update_section`
  (overwrites a section/subsection fully) and `append_to_section` (adds
  to the end without rewriting the rest — use this for checklists and
  running notes). Address a (sub)section by name, or by a `" > "`-joined
  path when the name alone is ambiguous, e.g. `"Checklist > Fase 2"`.
- `update_task` to change frontmatter (priority, tags, dependencies,
  status, ...) and/or replace whole sections in one call. It never
  renames the file — the task's path never changes just because its
  `title` changes. It also refuses to change `type`: if the task turns
  out to be the wrong type, create a new task of the right type instead.
- `end_task` when finished
  (moves the file into `.task_manager/tasks/done/` automatically — you never move it
  yourself for a status change). For a status your project defined
  itself in `task-config.yaml` (not one of the two reserved ones), use
  `change_status`.
- Before calling a task done, run `check_task` — it reports missing
  sections, duplicate section names, unrecognized status/priority
  values, and broken dependency paths, without modifying anything. If
  the only problems are missing sections, `fix_task` can add them
  (empty) automatically; anything else (duplicates, unrecognized
  values, broken dependencies) needs a manual fix, and `fix_task` will
  refuse to touch the file rather than guess.

## Groups

A task can carry a `group` id, right below `id` in its frontmatter. A
group is a set of related tasks: any two tasks joined by `dependencies`
or `based_on` can never end up with different (both-set) `group`
values — `create_task` and `update_task` enforce this and reject the
call with `group_conflict` if it would happen. You rarely need to set
`group` by hand: creating a task with a `dependencies`/`based_on` link
to an already-grouped task inherits that group automatically. `check_task`
reports a mismatch (`group_mismatch`) if a file was edited by hand into
an inconsistent state. To fetch every task in a group at once, use
`get_tasks_by_group` — it always searches both `.task_manager/tasks/` and
`.task_manager/tasks/done/`, since a group's tasks usually finish at different times
(unlike `list_tasks`, which excludes `.task_manager/tasks/done/` by default). `list_tasks`
also accepts a `group` filter if you just want to narrow a broader
search.

Each group also has an info file, `.task_manager/groups/<group>.md` (outside `.task_manager/tasks/`), created
automatically the first time a group id is used. Put context shared by
the whole group there (goal, constraints, decisions) instead of repeating
it in every task: read it with `get_group_info` and replace its body with
`update_group_info`. Group ids may only contain letters, digits, `.`,
`_` and `-`, since they are used as filenames.

## Renaming or reorganizing a task

Use `move_task` (never rewrite the frontmatter `path` by hand — there is
no such field, the path *is* the identity). It's a pure rename: it never
touches `status`, and it automatically rewrites the `dependencies` list
of every other task that referenced the old path. It fails outright if
the destination path already exists — it never overwrites silently.

## Creating a new task

`create_task` with `title` and `type` (required); `type` decides which
sections get generated (from `task-config.yaml`) — all of them, even if
empty. `type` must be one of the types defined in `task-config.yaml`
(check `get_task_config` if unsure) — an unrecognized one is rejected
with `unknown_type`, just like an unrecognized `status`/`priority`. If
the title's derived filename collides with an existing task
(active or in `.task_manager/tasks/done/`), creation fails; pick a different title
rather than expecting the server to auto-suffix it.

## Errors

Every tool returns `{ ok: false, error: { code, message } }` on
failure — check `code` to branch on the failure kind (e.g.
`unresolved_dependency`, `collision`, `unknown_status`, `unknown_type`,
`group_conflict`, `not_found`) instead of pattern-matching `message`,
which is only for display.

## Tool reference

`create_task`, `list_tasks`, `get_tasks_by_group`, `get_task`, `get_section`,
`get_task_description`, `get_task_config`, `check_task`, `fix_task`,
`update_task`, `update_section`, `append_to_section`, `delete_task`,
`move_task`, `end_task`,
`change_status`. Every one of these also exists as a CLI command (see
`todo-mcp-task-manager.txt`) for a human to run outside the agent.
