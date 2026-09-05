#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

function fail(message, code = 2) {
  console.error(`[octocode-query] ${message}`);
  process.exit(code);
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

function findWindowsOctocodeShim() {
  if (process.env.OCTOCODE_CLI_PATH) {
    if (!existsSync(process.env.OCTOCODE_CLI_PATH)) {
      fail(`OCTOCODE_CLI_PATH does not exist: ${process.env.OCTOCODE_CLI_PATH}`);
    }
    return process.env.OCTOCODE_CLI_PATH;
  }

  const where = spawnSync('where.exe', ['octocode.cmd'], {
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
  });

  if (where.status !== 0 || !where.stdout?.trim()) {
    fail(
      'Global Octocode command not found. Install once with: npm install -g octocode@latest'
    );
  }

  return where.stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(Boolean);
}

function runOctocode(tool, payload) {
  const queryJson = JSON.stringify(payload);
  let child;

  if (process.platform === 'win32') {
    const octocodeShim = findWindowsOctocodeShim();
    const comspec = process.env.ComSpec || 'cmd.exe';

    // On Windows, launch the npm .cmd shim through cmd.exe. This is the same
    // path that works interactively and avoids relying on Octocode's internal
    // JS entrypoint/bootstrap details.
    child = spawnSync(
      comspec,
      ['/d', '/c', octocodeShim, 'tools', tool, '--queries', queryJson, '--compact'],
      {
        stdio: 'inherit',
        windowsHide: true,
        shell: false,
        env: process.env,
        timeout: 45000,
      }
    );
  } else {
    const command = process.env.OCTOCODE_CLI_PATH || 'octocode';
    child = spawnSync(
      command,
      ['tools', tool, '--queries', queryJson, '--compact'],
      {
        stdio: 'inherit',
        shell: false,
        env: process.env,
        timeout: 45000,
      }
    );
  }

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

The wrapper builds Octocode query JSON inside Node and runs the installed
Octocode CLI with the current canonical tool names. On Windows it launches
octocode.cmd through cmd.exe to avoid PowerShell/cmd JSON-quoting issues and
internal CLI entrypoint/bootstrap differences.

Usage:
  node scripts/octocode-query.mjs tree --owner OWNER --repo REPO [--path PATH] [--depth 1] [--page-size 100]
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
      'ghViewRepoStructure',
      omitUndefined({
        owner: required(options, 'owner'),
        repo: required(options, 'repo'),
        path: options.path ?? '',
        branch,
        maxDepth: intOption(options, 'depth', 1),
        itemsPerPage: intOption(options, 'page-size', 100),
        page: intOption(options, 'page', undefined),
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
      'ghSearchCode',
      omitUndefined({
        keywords,
        owner: required(options, 'owner'),
        repo: required(options, 'repo'),
        path: options.path,
        extension: options.extension,
        filename: options.filename,
        match: options.match,
        page: intOption(options, 'page', undefined),
        limit: intOption(options, 'page-size', 10),
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
      'ghSearchRepos',
      omitUndefined({
        keywords,
        owner: options.owner,
        language: options.language,
        page: intOption(options, 'page', undefined),
        limit: intOption(options, 'page-size', 10),
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
        minify: fullContent ? undefined : minify,
      })
    );
    break;
  }

  default:
    fail(`Unknown command: ${command}. Run with --help.`);
}
