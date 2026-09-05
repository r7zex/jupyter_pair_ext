## Octocode GitHub research policy

When researching remote GitHub repositories, large codebases, external dependencies, or upstream implementations, use the repository wrapper `scripts/octocode-query.mjs` as the primary research/navigation layer.

Octocode MCP may not be exposed to the current Codex Desktop session. Direct `npx octocode ... --queries <json>` calls are also fragile on Windows because PowerShell/cmd can alter JSON quoting. The wrapper avoids both problems: it constructs JSON inside Node and launches the globally installed Octocode entrypoint with an argument array and `shell:false`.

### One-time prerequisite

Octocode must be installed globally on the Windows host:

```powershell
npm install -g octocode@latest
```

Do not reinstall it on every task.

### Canonical commands

Use these commands from the repository root. Do not use `npx --% octocode ...` unless the wrapper itself is unavailable.

Shallow repository tree:

```powershell
node scripts/octocode-query.mjs tree --owner OWNER --repo REPO --depth 1
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

Small/targeted file read:

```powershell
node scripts/octocode-query.mjs file --owner OWNER --repo REPO --path PATH --minify standard
```

The wrapper always requests Octocode `--compact` output internally.

### Required research workflow

1. Orient first with a shallow `tree` query (`--depth 1`).
2. Increase tree depth only for a relevant subtree; never request a deep whole-repository tree without need.
3. Search before reading. Use `code` to locate relevant symbols, filenames, strings, interfaces, functions, or implementations.
4. Read only known relevant files.
5. For an unknown or large file, use `symbols` first.
6. After identifying the relevant symbol, prefer `match` with small context or `range` with narrow line bounds.
7. Use `file --minify standard` for an ordinary targeted read where exact formatting is unnecessary.
8. Read complete exact content only for a genuinely small file when needed.
9. If Octocode returns partial content with a continuation offset, follow the continuation; partial content cannot prove absence.
10. A complete code-search snippet does not need to be fetched again unless more surrounding source is required.
11. Do not clone a remote repository merely to investigate it when Octocode provides sufficient evidence.
12. Do not dump entire repositories, deep directory trees, generated files, lockfiles, vendored code, or large source files into model context without a concrete need.
13. Avoid repeating evidence already obtained in the current task.
14. Octocode is the remote research/navigation layer. Normal local editing, compilation, tests, linting, Git operations, and targeted local inspection may still use the normal Codex tools.
15. Fall back to ordinary GitHub/web/shell inspection only when Octocode cannot retrieve the required evidence.

### Failure handling

If a wrapper call fails or hangs:

1. Stop it rather than waiting indefinitely.
2. Run:
   ```powershell
   node scripts/octocode-query.mjs --help
   ```
3. Verify the global package exists:
   ```powershell
   npm root -g
   ```
4. Do not silently switch to recursively reading the whole project. Report the concrete wrapper/Octocode error first.

### Token-efficiency priority

Prefer, in order:

1. shallow repository tree;
2. targeted code search;
3. symbol outline;
4. exact match with limited context;
5. narrow line range;
6. standard-minified file;
7. complete file only as a last resort.
