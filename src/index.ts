#!/usr/bin/env node
import { runStdioServer } from "./mcpServer.js";
import { buildCli } from "./cli.js";

function extractProjectRoot(argv: string[]): { projectRoot: string; rest: string[] } {
  const idx = argv.findIndex((a) => a === "--project");
  if (idx !== -1 && argv[idx + 1] !== undefined) {
    const projectRoot = argv[idx + 1];
    const rest = [...argv.slice(0, idx), ...argv.slice(idx + 2)];
    return { projectRoot, rest };
  }
  return { projectRoot: process.env.MCP_TASK_PROJECT_ROOT ?? process.cwd(), rest: argv };
}

async function main(): Promise<void> {
  const { projectRoot, rest } = extractProjectRoot(process.argv.slice(2));

  if (rest.length === 0 || rest[0] === "serve") {
    await runStdioServer(projectRoot);
    return;
  }

  const program = buildCli(projectRoot);
  await program.parseAsync(["node", "mcp-task-manager", ...rest]);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
