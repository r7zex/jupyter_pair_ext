#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function fail(message, code = 2) {
  console.error(`[octocode-query] ${message}`);
  process.exit(code);
}

function resolveOctocodeFromGlobalRoot(globalRoot) {
  if (!globalRoot) return undefined;

  const packageDir = path.join(globalRoot.trim(), 'octocode');
  const packageJsonPath = path.join(packageDir, 'package.json');
  if (!existsSync(packageJsonPath)) return undefined;

  try {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
    const bin =
      typeof packageJson.bin === 'string'
        ? packageJson.bin
        : packageJson.bin?.octocode ?? Object.values(packageJson.bin ?? {})[0];

    if (typeof bin === 'string') {
      const entrypoint = path.resolve(packageDir, bin);
      if (existsSync(entrypoint)) return entrypoint;
    }
  } catch {
    // Fall through to the published default path below.
  }

  const fallback = path.join(packageDir, 'out', 'octocode.js');
  return existsSync(fallback) ? fallback : undefined;
}

function getGlobalNpmRoots() {
  const roots = new Set();

  if (process.env.APPDATA) {
    roots.add(path.join(process.env.APPDATA, 'npm', 'node_modules'));
  }

  if (process.env.NPM_CONFIG_PREFIX) {
    roots.add(path.join(process.env.NPM_CONFIG_PREFIX, 'node_modules'));
  }

  // Prefer running npm's JS entrypoint directly through the current node.exe.
  // This avoids the Windows npm.cmd shell wrapper entirely.
  const npmCliCandidates = [
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];

  for (const npmCli of npmCliCandidates) {
    if (!existsSync(npmCli)) continue;
    const result = spawnSync(process.execPath, [npmCli, 'root', '-g'], {
      encoding: 'utf8',
      windowsHide: true,
      shell: false,
    });
    if (result.status === 0 && result.stdout?.trim()) {
      roots.add(result.stdout.trim());
    }
  }

  // Fallback for Windows installations where npm is exposed only through npm.cmd.
  // No user JSON is passed through cmd.exe here, so quoting is not a concern.
  if (process.platform === 'win32' && process.env.ComSpec) {
    const result = spawnSync(
      process.env.ComSpec,
      ['/d', '/s', '/c', 'npm root -g'],
      {
        encoding: 'utf8',
        windowsHide: true,
        shell: false,
      }
    );
    if (result.status === 0 && result.stdout?.trim()) {
      roots.add(result.stdout.trim());
    }

    // npm's global command shim normally lives next to the global node_modules.
    const where = spawnSync('where.exe', ['octocode.cmd'], {
      encoding: 'utf8',
      windowsHide: true,
      shell: false,
    });
    if (where.status === 0 && where.stdout?.trim()) {
      for (const shim of where.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean)) {
        roots.add(path.join(path.dirname(shim), 'node_modules'));
      }
    }
  }

  return [...roots];
}

function findOctocodeEntrypoint() {
  if (process.env.OCTOCODE_CLI_PATH && existsSync(process.env.OCTOCODE_CLI_PATH)) {
    return process.env.OCTOCODE_CLI_PATH;
  }

  for (const root of getGlobalNpmRoots()) {
    const entrypoint = resolveOctocodeFromGlobalRoot(root);
    if (entrypoint) return entrypoint;
  }

  return undefined;
}

function parseOptions(argv) {
  const options = {};
  const repeated = new Set(['keyword']);

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      fail(`Unexpected positional argument: ${token}`);
    }

    const key = token.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      fail(`Missing value for --${key}`);
    }
    i += 1;

    if (repeated.has(key)) {
      options[key] ??= [];
      options[key].push(value);
    } else {
      options[key] = value;
    }
  }

  return options;
}

function required(options, key) {
  const value = options[key];
  if (value === undefined || value === '') {
    fail(`Missing required option --${key}`);
  }
  return value;
}

function intOption(options, key, fallback) {
  if (options[key] === undefined) return fallback;
  const value = Number.parseInt(options[key], 10);
  if (!Number.isInteger(value)) fail(`--${key} must be an integer`);
  return value;
}

function boolOption(options, key, fallback = false) {
  if (options[key] === undefined) return fallback;
  const value = String(options[key]).toLowerCase();
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  fail(`--${key} must be true or false`);
}

function omitUndefined(object) {
  return Object.fromEntries(
    Object.entries(object).filter(([, value]) => value !== undefined)
  );
}

function runOctocode(tool, payload) {
  const entrypoint = findOctocodeEntrypoint();
  if (!entrypoint) {
    const searchedRoots = getGlobalNpmRoots();
    fail(
      `Global Octocode package not found. npm roots checked: ${
        searchedRoots.length ? searchedRoots.join(', ') : '(none resolved)'
      }. Install once with: npm install -g octocode@latest`
    );
  }

  const child = spawnSync(
    process.execPath,
    [entrypoint, 'tools', tool, '--queries', JSON.stringify(payload), '--compact'],
    {
      stdio: 'inherit',
      windowsHide: true,
      shell: false,
      env: process.env,
      timeout: 45000,
    }
  );

  if (child.error) {
    if (child.error.code === 'ETIMEDOUT') {
      fail('Octocode timed out after 45 seconds.', 1);
    }
    fail(`Failed to launch Octocode: ${child.error.message}`, 1);
  }

  process.exit(child.status ?? 1);
}

function usage() {
  console.log(`Windows-safe Octocode wrapper for Codex Desktop.

The wrapper builds JSON inside Node and launches the globally installed
Octocode entrypoint with an argv array, bypassing PowerShell/cmd JSON quoting.

Usage:
  node scripts/octocode-query.mjs tree --owner OWNER --repo REPO [--path PATH] [--depth 1]
  node scripts/octocode-query.mjs code --owner OWNER --repo REPO --keyword TERM [--keyword TERM2] [--path PATH] [--page-size 10]
  node scripts/octocode-query.mjs repos --keyword TERM [--keyword TERM2] [--page-size 10]
  node scripts/octocode-query.mjs symbols --owner OWNER --repo REPO --path PATH
  node scripts/octocode-query.mjs match --owner OWNER --repo REPO --path PATH --text TEXT [--context 8] [--regex false]
  node scripts/octocode-query.mjs range --owner OWNER --repo REPO --path PATH --start N --end N
  node scripts/octocode-query.mjs file --owner OWNER --repo REPO --path PATH [--minify standard] [--full false]

Examples:
  node scripts/octocode-query.mjs tree --owner r7zex --repo jupyter_pair_ext --depth 1
  node scripts/octocode-query.mjs code --owner r7zex --repo jupyter_pair_ext --keyword heartbeat --page-size 10
  node scripts/octocode-query.mjs symbols --owner r7zex --repo jupyter_pair_ext --path src/extension.ts
`);
}

const [command, ...rest] = process.argv.slice(2);
if (!command || command === 'help' || command === '--help' || command === '-h') {
  usage();
  process.exit(0);
}

const options = parseOptions(rest);
const branch = options.branch;

switch (command) {
  case 'tree': {
    runOctocode(
      'ghSearch',
      omitUndefined({
        operation: 'tree',
        owner: required(options, 'owner'),
        repo: required(options, 'repo'),
        path: options.path,
        branch,
        maxDepth: intOption(options, 'depth', 1),
      })
    );
    break;
  }

  case 'code': {
    const keywords = options.keyword;
    if (!Array.isArray(keywords) || keywords.length === 0) {
      fail('code requires at least one --keyword');
    }
    runOctocode(
      'ghSearch',
      omitUndefined({
        operation: 'code',
        keywords,
        owner: required(options, 'owner'),
        repo: required(options, 'repo'),
        path: options.path,
        extension: options.extension,
        filename: options.filename,
        pageSize: intOption(options, 'page-size', 10),
      })
    );
    break;
  }

  case 'repos': {
    const keywords = options.keyword;
    if (!Array.isArray(keywords) || keywords.length === 0) {
      fail('repos requires at least one --keyword');
    }
    runOctocode(
      'ghSearch',
      omitUndefined({
        operation: 'repositories',
        keywords,
        language: options.language,
        pageSize: intOption(options, 'page-size', 10),
      })
    );
    break;
  }

  case 'symbols': {
    runOctocode(
      'ghGetFileContent',
      omitUndefined({
        owner: required(options, 'owner'),
        repo: required(options, 'repo'),
        path: required(options, 'path'),
        branch,
        minify: 'symbols',
      })
    );
    break;
  }

  case 'match': {
    runOctocode(
      'ghGetFileContent',
      omitUndefined({
        owner: required(options, 'owner'),
        repo: required(options, 'repo'),
        path: required(options, 'path'),
        branch,
        matchString: required(options, 'text'),
        matchStringIsRegex: boolOption(options, 'regex', false),
        contextLines: intOption(options, 'context', 8),
      })
    );
    break;
  }

  case 'range': {
    runOctocode(
      'ghGetFileContent',
      omitUndefined({
        owner: required(options, 'owner'),
        repo: required(options, 'repo'),
        path: required(options, 'path'),
        branch,
        startLine: intOption(options, 'start'),
        endLine: intOption(options, 'end'),
      })
    );
    break;
  }

  case 'file': {
    const fullContent = boolOption(options, 'full', false);
    const minify = options.minify ?? 'standard';
    if (!['none', 'standard', 'symbols'].includes(minify)) {
      fail('--minify must be none, standard, or symbols');
    }
    runOctocode(
      'ghGetFileContent',
      omitUndefined({
        owner: required(options, 'owner'),
        repo: required(options, 'repo'),
        path: required(options, 'path'),
        branch,
        fullContent: fullContent || undefined,
        minify,
      })
    );
    break;
  }

  default:
    fail(`Unknown command: ${command}. Run with --help.`);
}
