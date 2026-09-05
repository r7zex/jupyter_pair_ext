# Codex workflow: sync locally, research through Octocode, then edit

This repository is intended to be used from a local Codex Desktop workspace. The local checkout is the place where edits, builds, tests, and Git operations happen. Initial codebase research must be done through Octocode so that large amounts of source code are not loaded into model context unnecessarily.

## 1. Start every task by synchronizing the local checkout

Before researching or editing project code:

1. Confirm the current working directory is this repository.
2. Check local Git state with:

   ```powershell
   git status --short
   ```

3. If the working tree is clean, update `main` with:

   ```powershell
   git -c http.sslBackend=schannel pull --ff-only origin main
   ```

4. If the working tree has local modifications, do **not** discard, reset, stash, rebase, or overwrite them automatically. Report that the tree is dirty and preserve the user's work. Continue only in a way that cannot destroy those changes.

The `schannel` override is intentional for this Windows environment because the OpenSSL Git backend may fail to connect to GitHub.

## 2. Octocode is mandatory for the initial research phase

After synchronization, do **not** begin by recursively inspecting the local repository.

During the initial discovery/research phase, do not use local `rg`, recursive `Get-ChildItem`, broad file reads, IDE-wide search, or sequentially open source files to understand the codebase.

Use the repository wrapper:

```powershell
node scripts/octocode-query.mjs ...
```

The wrapper builds Octocode JSON inside Node and launches the globally installed Octocode CLI without PowerShell/cmd JSON-quoting problems. It requests compact output automatically.

### One-time prerequisite

Octocode must be installed globally on the Windows host:

```powershell
npm install -g octocode@latest
```

Do not reinstall it on every task.

## 3. Canonical Octocode commands

Shallow repository tree:

```powershell
node scripts/octocode-query.mjs tree --owner OWNER --repo REPO --depth 1
```

For this repository:

```powershell
node scripts/octocode-query.mjs tree --owner r7zex --repo jupyter_pair_ext --depth 1
```

Targeted code search:

```powershell
node scripts/octocode-query.mjs code --owner OWNER --repo REPO --keyword SYMBOL_OR_TERM --page-size 10
```

Multiple ANDed search terms:

```powershell
node scripts/octocode-query.mjs code --owner OWNER --repo REPO --keyword TERM1 --keyword TERM2 --page-size 10
```

Repository discovery:

```powershell
node scripts/octocode-query.mjs repos --keyword TERM --page-size 10
```

Symbol outline for a known large file:

```powershell
node scripts/octocode-query.mjs symbols --owner OWNER --repo REPO --path PATH
```

Matched slice around a known symbol/text:

```powershell
node scripts/octocode-query.mjs match --owner OWNER --repo REPO --path PATH --text SYMBOL_OR_TEXT --context 8
```

Narrow line range:

```powershell
node scripts/octocode-query.mjs range --owner OWNER --repo REPO --path PATH --start START --end END
```

Small/targeted file read through Octocode:

```powershell
node scripts/octocode-query.mjs file --owner OWNER --repo REPO --path PATH --minify standard
```

## 4. Required research order

Use this sequence before opening project source locally:

1. `tree --depth 1` for orientation.
2. Increase tree depth only for a relevant subtree.
3. `code` searches for the requested behavior, symbol, protocol, error text, filename, or implementation.
4. For a large/unknown file, use `symbols` first.
5. Use `match` with small context or a narrow `range` for exact evidence.
6. Repeat targeted Octocode searches only when the evidence requires it.

Do not request a deep tree for the whole repository. Do not dump generated files, lockfiles, vendored code, or large source files into context without a concrete need.

A complete Octocode search snippet does not need to be fetched again unless more surrounding source is required.

## 5. Transition from research to local editing

Once Octocode has identified the relevant files/symbols and the task is sufficiently scoped, local project access is allowed.

At that point Codex may:

- open the specific local files identified by Octocode;
- inspect nearby dependent files when needed to make a correct change;
- use targeted local `rg`/search for exact references after the relevant area is known;
- edit local files;
- run formatters, linters, compilers, tests, and package scripts;
- inspect diffs and Git status;
- create commits only when the user's task calls for it.

Do not re-read the whole repository locally just because local access is now allowed. Keep local reads targeted to the implementation area discovered through Octocode.

## 6. Remote versus local source of truth

- **Research/navigation:** prefer Octocode against GitHub.
- **Editing/testing:** use the synchronized local checkout.
- If local `main` was successfully pulled at task start, Octocode's default-branch GitHub view and the local checkout should describe the same source revision.
- After making local edits, the local working tree becomes the source of truth for those changed files. Do not expect Octocode's GitHub view to contain unpushed local modifications.

## 7. Prohibited initial shortcuts

Before the Octocode research phase has identified the relevant implementation area, do not:

- recursively read the local repository;
- run broad local searches across all source merely to understand architecture;
- open many files sequentially;
- clone another copy of the same repository;
- use ordinary web search as a substitute for repository research;
- use Octocode MCP when it is unavailable in the Codex Desktop session;
- bypass the wrapper with fragile direct `--queries` JSON commands on Windows.

## 8. Failure handling

If a wrapper call fails or hangs:

1. Stop it rather than waiting indefinitely.
2. Run:

   ```powershell
   node scripts/octocode-query.mjs --help
   ```

3. Verify the global package installation if necessary:

   ```powershell
   npm root -g
   ```

4. Report the concrete wrapper/Octocode error.
5. Do not silently replace Octocode research with a full local repository scan.

If GitHub synchronization fails, report the exact Git error. Do not reset or destroy local state to force a pull.

## 9. Token-efficiency priority

Prefer, in order:

1. shallow repository tree;
2. targeted code search;
3. symbol outline;
4. exact match with limited context;
5. narrow line range;
6. standard-minified file;
7. targeted local reads of already identified files;
8. complete file only when genuinely required.

Avoid repeating evidence already obtained in the current task.