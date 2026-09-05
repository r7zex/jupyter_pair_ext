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

function executeOctocode(tool, payload) {
  const queryJson = JSON.stringify(payload);

  if (process.platform === 'win32') {
    const octocodeShim = findWindowsOctocodeShim();
    const comspec = process.env.ComSpec || 'cmd.exe';
    return spawnSync(
      comspec,
      ['/d', '/c', octocodeShim, 'tools', tool, '--queries', queryJson, '--compact'],
      {
        encoding: 'utf8',
        windowsHide: true,
        shell: false,
        env: process.env,
        timeout: 45000,
      }
    );
  }

  const command = process.env.OCTOCODE_CLI_PATH || 'octocode';
  return spawnSync(
    command,
    ['tools', tool, '--queries', queryJson, '--compact'],
    {
      encoding: 'utf8',
      shell: false,
      env: process.env,
      timeout: 45000,
    }
  );
}

function emitResult(result) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

function isUnknownTool(result) {
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  return /Unknown tool:/i.test(output);
}

function runOctocode(candidates) {
  for (let i = 0; i < candidates.length; i += 1) {
    const { tool, payload } = candidates[i];
    const child = executeOctocode(tool, payload);

    if (child.error) {
      if (child.error.code === 'ETIMEDOUT') {
        fail('Octocode timed out after 45 seconds.', 1);
      }
      fail(`Failed to launch Octocode: ${child.error.message}`, 1);
    }

    // Octocode v18.4 exposes ghSearch for tree/code/repository operations,
    // while newer builds split those operations into dedicated tools. Try the
    // installed v18.4 surface first and fall back only when the tool itself is
    // unavailable. Do not hide real query/provider errors.
    if (isUnknownTool(child) && i + 1 < candidates.length) {
      continue;
    }

    emitResult(child);
    process.exit(child.status ?? 1);
  }

  fail('No compatible Octocode tool was available.', 1);
}

function usage() {
  console.log(`Windows-safe Octocode wrapper for Codex Desktop.

The wrapper builds Octocode query JSON inside Node. On Windows it launches the
installed octocode.cmd through cmd.exe, which avoids PowerShell/cmd JSON quoting
problems and avoids depending on Octocode internal JS entrypoints.

It supports the installed Octocode v18.4 tool inventory (ghSearch) and falls
back to the newer split GitHub tool names when necessary.

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
    const owner = required(options, 'owner');
    const repo = required(options, 'repo');
    const path = options.path;
    const maxDepth = intOption(options, 'depth', 1);
    const pageSize = intOption(options, 'page-size', 100);
    const page = intOption(options, 'page', undefined);

    runOctocode([
      {
        tool: 'ghSearch',
        payload: omitUndefined({
          operation: 'tree',
          owner,
          repo,
          path,
          branch,
          maxDepth,
          pageSize,
          page,
        }),
      },
      {
        tool: 'ghViewRepoStructure',
        payload: omitUndefined({
          owner,
          repo,
          path: path ?? '',
          branch,
          maxDepth,
          itemsPerPage: pageSize,
          page,
        }),
      },
    ]);
    break;
  }

  case 'code': {
    const keywords = options.keyword;
    if (!Array.isArray(keywords) || keywords.length === 0) {
      fail('code requires at least one --keyword');
    }

    const owner = required(options, 'owner');
    const repo = required(options, 'repo');
    const pageSize = intOption(options, 'page-size', 10);
    const page = intOption(options, 'page', undefined);

    runOctocode([
      {
        tool: 'ghSearch',
        payload: omitUndefined({
          operation: 'code',
          keywords,
          owner,
          repo,
          path: options.path,
          extension: options.extension,
          filename: options.filename,
          match: options.match,
          pageSize,
          page,
        }),
      },
      {
        tool: 'ghSearchCode',
        payload: omitUndefined({
          keywords,
          owner,
          repo,
          path: options.path,
          extension: options.extension,
          filename: options.filename,
          match: options.match,
          limit: pageSize,
          page,
        }),
      },
    ]);
    break;
  }

  case 'repos': {
    const keywords = options.keyword;
    if (!Array.isArray(keywords) || keywords.length === 0) {
      fail('repos requires at least one --keyword');
    }

    const pageSize = intOption(options, 'page-size', 10);
    const page = intOption(options, 'page', undefined);

    runOctocode([
      {
        tool: 'ghSearch',
        payload: omitUndefined({
          operation: 'repositories',
          keywords,
          owner: options.owner,
          language: options.language,
          pageSize,
          page,
        }),
      },
      {
        tool: 'ghSearchRepos',
        payload: omitUndefined({
          keywords,
          owner: options.owner,
          language: options.language,
          limit: pageSize,
          page,
        }),
      },
    ]);
    break;
  }

  case 'symbols': {
    runOctocode([
      {
        tool: 'ghGetFileContent',
        payload: omitUndefined({
          owner: required(options, 'owner'),
          repo: required(options, 'repo'),
          path: required(options, 'path'),
          branch,
          minify: 'symbols',
        }),
      },
    ]);
    break;
  }

  case 'match': {
    runOctocode([
      {
        tool: 'ghGetFileContent',
        payload: omitUndefined({
          owner: required(options, 'owner'),
          repo: required(options, 'repo'),
          path: required(options, 'path'),
          branch,
          matchString: required(options, 'text'),
          matchStringIsRegex: boolOption(options, 'regex', false),
          contextLines: intOption(options, 'context', 8),
        }),
      },
    ]);
    break;
  }

  case 'range': {
    runOctocode([
      {
        tool: 'ghGetFileContent',
        payload: omitUndefined({
          owner: required(options, 'owner'),
          repo: required(options, 'repo'),
          path: required(options, 'path'),
          branch,
          startLine: intOption(options, 'start'),
          endLine: intOption(options, 'end'),
        }),
      },
    ]);
    break;
  }

  case 'file': {
    const fullContent = boolOption(options, 'full', false);
    const minify = options.minify ?? 'standard';
    if (!['none', 'standard', 'symbols'].includes(minify)) {
      fail('--minify must be none, standard, or symbols');
    }

    runOctocode([
      {
        tool: 'ghGetFileContent',
        payload: omitUndefined({
          owner: required(options, 'owner'),
          repo: required(options, 'repo'),
          path: required(options, 'path'),
          branch,
          fullContent: fullContent || undefined,
          minify: fullContent ? undefined : minify,
        }),
      },
    ]);
    break;
  }

  default:
    fail(`Unknown command: ${command}. Run with --help.`);
}
