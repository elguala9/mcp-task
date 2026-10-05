#!/usr/bin/env node
// Usage: npm run release [-- patch|minor|major|<x.y.z>] [--skip-registry]
// Without a bump argument the current version is released as-is.
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const skipRegistry = args.includes('--skip-registry');
const bump = args.find((a) => !a.startsWith('--'));

const run = (cmd, opts = {}) => {
  console.log(`\n> ${cmd}`);
  return execSync(cmd, { stdio: 'inherit', ...opts });
};
const out = (cmd) => execSync(cmd, { encoding: 'utf8' }).trim();
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const writeJson = (p, data) => writeFileSync(p, JSON.stringify(data, null, 2) + '\n');
const has = (cmd) => {
  try {
    execSync(`${cmd} --version`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

if (out('git status --porcelain')) {
  console.error('Working tree is not clean: commit or stash your changes first.');
  process.exit(1);
}

run('npm test');

if (bump) run(`npm version ${bump} --no-git-tag-version`);

const pkg = readJson('package.json');
const version = pkg.version;

const server = readJson('server.json');
server.version = version;
for (const p of server.packages ?? []) p.version = version;
writeJson('server.json', server);

const plugin = readJson('.claude-plugin/plugin.json');
plugin.version = version;
writeJson('.claude-plugin/plugin.json', plugin);

run('npm run build');

if (out('git status --porcelain')) {
  run('git add package.json package-lock.json server.json .claude-plugin/plugin.json');
  run(`git commit -m "Release ${version}" -m "Commit fatto da © Omnia Group S.r.l."`);
}

let published = false;
try {
  published = out(`npm view ${pkg.name}@${version} version`) === version;
} catch {}
if (published) console.log(`\n${pkg.name}@${version} is already on npm, skipping npm publish.`);
else run('npm publish --access public');

if (skipRegistry) console.log('\nSkipping MCP registry (--skip-registry).');
else if (has('mcp-publisher')) run('mcp-publisher publish');
else console.log('\nmcp-publisher not found, skipping MCP registry. Install it and run: mcp-publisher login github && mcp-publisher publish');

const tag = `v${version}`;
if (!out(`git tag -l ${tag}`)) run(`git tag ${tag}`);

run('git push');
run(`git push origin ${tag}`.replace('origin', out('git remote').split('\n')[0]));

console.log(`\nReleased ${version}.`);
