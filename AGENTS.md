## Octocode GitHub research policy

When researching remote GitHub repositories, large codebases, external dependencies, or upstream implementations, use Octocode CLI as the primary research/navigation layer.

Octocode MCP may not be exposed to the current Codex Desktop session. If MCP tools are unavailable, invoke Octocode through the shell.

### Available Octocode tools

Use primarily:

- `ghSearch`
  - `operation:"tree"` — browse a known repository structure.
  - `operation:"code"` — search code or paths.
  - `operation:"repositories"` — discover repositories.
- `ghGetFileContent` — read a known path after discovery.

Do not assume deprecated Octocode CLI tool names such as `ghViewRepoStructure`, `ghSearchCode`, or `ghSearchRepos` exist.

### Required research workflow

1. Orient first. For a known repository, start with `ghSearch` using `operation:"tree"` and `maxDepth:1`.
2. Keep tree exploration shallow. Increase depth only for a relevant subtree instead of requesting a deep tree for the whole repository.
3. Search before reading. Use `ghSearch` with `operation:"code"` to locate relevant symbols, filenames, strings, interfaces, functions, or implementations.
4. Read only known relevant files. After obtaining an exact path, use `ghGetFileContent`.
5. For an unknown or large file, read a symbol outline first with `minify:"symbols"`.
6. After identifying the relevant symbol, prefer `matchString` with a small `contextLines` value or a narrow `startLine` + `endLine` range.
7. For ordinary targeted reads where exact formatting is unnecessary, prefer `minify:"standard"`.
8. Use `minify:"none"` or `fullContent:true` only for small files where exact complete contents are genuinely required, such as short config files.
9. If Octocode returns partial content with a continuation offset, continue using the returned `charOffset`; partial content cannot prove absence.
10. A complete code-search snippet does not need to be fetched again unless additional surrounding source is required.
11. Do not clone a remote repository merely to investigate it when `ghSearch` and `ghGetFileContent` provide sufficient evidence.
12. Do not dump entire repositories, deep directory trees, generated files, lockfiles, vendored code, or large source files into model context without a concrete need.
13. Use Octocode CLI `--compact` output for research calls.
14. Batch related queries when the tool schema supports batching instead of performing redundant calls.
15. If the exact Octocode input schema is uncertain, inspect it first with `npx octocode tools <tool> --scheme`.
16. On Windows PowerShell, JSON passed through `npx.cmd` may lose quoting. If direct JSON parsing fails, use PowerShell stop-parsing syntax: `npx --% octocode tools ...` and escape JSON quotes as `\"`.
17. Octocode is the research/navigation layer. Normal local editing, compilation, tests, linting, Git operations, and targeted local inspection may still use the usual Codex tools.
18. Fall back to ordinary GitHub/web/shell inspection only when Octocode cannot retrieve the required evidence.

### Token-efficiency priority

Prefer, in order:

1. shallow repository tree;
2. targeted code search;
3. symbol outline;
4. exact function/match with limited context;
5. narrow line range;
6. standard-minified file;
7. complete file only as a last resort.

Avoid repeating evidence already obtained in the current task.

### Windows PowerShell command patterns

Shallow tree:

```powershell
npx --% octocode tools ghSearch --queries "{\"operation\":\"tree\",\"owner\":\"OWNER\",\"repo\":\"REPO\",\"maxDepth\":1}" --compact
```

Targeted code search:

```powershell
npx --% octocode tools ghSearch --queries "{\"operation\":\"code\",\"keywords\":[\"SYMBOL_OR_TERM\"],\"owner\":\"OWNER\",\"repo\":\"REPO\",\"pageSize\":10}" --compact
```

Symbol outline for a known large file:

```powershell
npx --% octocode tools ghGetFileContent --queries "{\"owner\":\"OWNER\",\"repo\":\"REPO\",\"path\":\"PATH\",\"minify\":\"symbols\"}" --compact
```

Matched slice:

```powershell
npx --% octocode tools ghGetFileContent --queries "{\"owner\":\"OWNER\",\"repo\":\"REPO\",\"path\":\"PATH\",\"matchString\":\"SYMBOL_OR_TEXT\",\"contextLines\":8}" --compact
```

Narrow line range:

```powershell
npx --% octocode tools ghGetFileContent --queries "{\"owner\":\"OWNER\",\"repo\":\"REPO\",\"path\":\"PATH\",\"startLine\":START,\"endLine\":END}" --compact
```
