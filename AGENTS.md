# Codex workflow: targeted research, minimal context, then edit

This repository is intended to be used from a local Codex Desktop workspace. The local checkout is the place where edits, builds, tests, and Git operations happen. Repository research must be narrow and evidence-driven so that source code and tool output do not accumulate unnecessarily in model context.

## 1. Start by preserving local state

Before editing project code:

1. Confirm the current working directory is this repository.
2. Check local Git state with:

   ```powershell
   git status --short
   ```

3. If the working tree is clean and the task depends on current GitHub state, update `main` with:

   ```powershell
   git -c http.sslBackend=schannel pull --ff-only origin main
   ```

4. If the working tree has local modifications, do **not** discard, reset, stash, rebase, or overwrite them automatically. Preserve the user's work and continue only in a way that cannot destroy those changes.

Do not perform Git synchronization merely to answer a trivial question when the current local checkout is already sufficient.

The `schannel` override is intentional for this Windows environment because the OpenSSL Git backend may fail to connect to GitHub.

## 2. Octocode is the primary repository-research tool

Do **not** recursively inspect the local repository to understand the codebase.

For discovery/research, prefer the repository wrapper:

```powershell
node scripts/octocode-query.mjs ...
```

The wrapper builds Octocode JSON inside Node and launches the globally installed Octocode CLI without PowerShell/cmd JSON-quoting problems. It requests compact output automatically.

Octocode must already be installed globally on the Windows host:

```powershell
npm install -g octocode@latest
```

Do not reinstall, update, diagnose, or reconfigure Octocode on each task unless an Octocode call actually fails.

## 3. Critical token-efficiency rules

The goal is to minimize **active model context and repeated tool output**, not merely to minimize the number of tool calls.

Always follow these rules:

- Never read the whole project to understand a task.
- Never begin with a repository tree if the user's prompt already names a file, symbol, feature, error, protocol, UI element, or behavior that can be searched directly.
- Do not fetch a full file when a match, symbol outline, or narrow range is sufficient.
- Prefer exact symbols, error text, protocol names, event names, commands, and distinctive strings over broad conceptual searches.
- Keep search result counts small. Default to the smallest page size that can answer the question.
- Keep match context small. Increase it only when the missing surrounding code is necessary.
- Keep line-range reads narrow. Expand incrementally rather than requesting hundreds of lines pre-emptively.
- Do not repeat a search, file slice, symbol outline, or tree result already obtained in the current task.
- Do not request the same evidence through both Octocode and Tree-sitter unless the second tool answers a genuinely different question.
- Do not paste or restate raw tool output in reasoning. Retain only the facts needed for the next action: path, symbol, relevant line/range, dependency, and conclusion.
- Stop researching once there is enough evidence to answer the user's question or safely scope the edit. Do not continue exploring architecture "for completeness".
- Generated files, lockfiles, vendored code, build output, large fixtures, and unrelated tests must not be loaded without a concrete need.

### Lightweight inspection mode

For requests such as "глянь", "проверь", "где проблема", "что здесь происходит", or another small inspection task:

1. Search directly for the named behavior/symbol/error.
2. Read only the smallest relevant snippet(s).
3. Follow only dependencies required to establish the answer.
4. Do not run a repository tree merely for orientation.
5. Do not run builds, full test suites, broad searches, or architecture discovery unless they are necessary to verify a concrete finding.
6. Once the answer is established, stop.

A small inspection must not turn into a repository audit.

## 4. Canonical Octocode commands

Targeted code search:

```powershell
node scripts/octocode-query.mjs code --owner OWNER --repo REPO --keyword SYMBOL_OR_TERM --page-size 5
```

Multiple ANDed search terms:

```powershell
node scripts/octocode-query.mjs code --owner OWNER --repo REPO --keyword TERM1 --keyword TERM2 --page-size 5
```

Symbol outline for a known large file:

```powershell
node scripts/octocode-query.mjs symbols --owner OWNER --repo REPO --path PATH
```

Matched slice around a known symbol/text:

```powershell
node scripts/octocode-query.mjs match --owner OWNER --repo REPO --path PATH --text SYMBOL_OR_TEXT --context 5
```

Narrow line range:

```powershell
node scripts/octocode-query.mjs range --owner OWNER --repo REPO --path PATH --start START --end END
```

Small/targeted file read through Octocode:

```powershell
node scripts/octocode-query.mjs file --owner OWNER --repo REPO --path PATH --minify standard
```

Shallow repository tree, **only when the relevant area is genuinely unknown**:

```powershell
node scripts/octocode-query.mjs tree --owner r7zex --repo jupyter_pair_ext --depth 1
```

Repository discovery, only when researching another repository is part of the task:

```powershell
node scripts/octocode-query.mjs repos --keyword TERM --page-size 5
```

## 5. Required research strategy

Use the cheapest targeted operation that can answer the next concrete question.

Preferred order when the task already gives a useful clue:

1. `code` search for the exact symbol, error, behavior, event, protocol, or distinctive text.
2. `match` for a small slice around the relevant hit.
3. `symbols` if the file is large and its structure is still unclear.
4. `range` for exact neighboring implementation details.
5. Follow only the specific dependency/reference needed to prove the behavior.

Only when there is no useful clue at all:

1. use `tree --depth 1` once;
2. choose the relevant subtree;
3. immediately return to targeted searches.

Do not request a deep tree for the whole repository. A complete Octocode snippet does not need to be fetched again unless specific additional surrounding source is required.

## 6. Tree-sitter usage

Tree-sitter is for **local structural questions after the relevant file or symbol is known**.

Use it for narrow tasks such as:

- locating a known function/class/symbol;
- finding usages of a known symbol;
- checking dependencies of a known file;
- obtaining a call graph for a known function;
- extracting a precise source range.

Do not use Tree-sitter to recursively explore the entire project, recreate a repository map, or duplicate an Octocode search that already established the relevant location.

When Octocode has already identified the exact file and symbol, prefer one narrow Tree-sitter query over opening the whole file if that answers the question.

## 7. Transition from research to local editing

Once Octocode has identified the relevant files/symbols and the task is sufficiently scoped, local project access is allowed.

At that point Codex may:

- open the specific local files identified by Octocode;
- inspect a small amount of nearby code required for a correct change;
- use targeted local `rg`/search for exact references after the relevant area is known;
- edit local files;
- run only the formatters, linters, compilers, tests, or package scripts that are relevant to the change;
- inspect diffs and Git status;
- create commits only when the user's task calls for it.

Do not re-read the whole repository locally just because local access is now allowed. Do not run a full test suite when a targeted test can validate the change.

## 8. Remote versus local source of truth

- **Research/navigation:** prefer Octocode against GitHub.
- **Known local structural lookup:** use Tree-sitter narrowly.
- **Editing/testing:** use the local checkout.
- After making local edits, the local working tree becomes the source of truth for changed files.
- Do not use the remote GitHub/Octocode version to verify unpushed local edits.

## 9. Prohibited broad-context behavior

Do not:

- recursively read the repository;
- run broad local `rg`/IDE searches merely to understand architecture;
- open many files sequentially;
- fetch complete large files when snippets suffice;
- request deep repository trees without a concrete reason;
- dump raw JSON/tool output into the conversation;
- reread evidence already obtained;
- perform speculative searches after the task is already scoped;
- use ordinary web search as a substitute for repository research;
- clone another copy of the same repository;
- diagnose MCP, Node, npm, PATH, Octocode, or Tree-sitter unless an actual tool invocation fails;
- use unavailable MCP tools as a reason to scan the project locally.

## 10. Failure handling

If an Octocode wrapper call fails or hangs:

1. Stop it rather than waiting indefinitely.
2. Run only the minimum diagnostic needed to establish the concrete failure.
3. Report the concrete error.
4. Do not silently replace Octocode research with a full local repository scan.

If GitHub synchronization fails, report the exact Git error. Do not reset or destroy local state to force a pull.

## 11. Context hygiene during long tasks

During multi-step work, treat old tool output as disposable evidence rather than material that must be repeatedly revisited.

After a research phase, retain a compact working state containing only:

- task goal and constraints;
- confirmed root cause or current hypothesis;
- affected file paths;
- relevant symbols/functions;
- exact small ranges when needed;
- dependencies that matter;
- next action;
- tests still required.

Do not re-open old search results merely to reconstruct information that was already established. If the client performs context compaction, the compact state above is the information that should survive; raw searches, full logs, large diffs, and obsolete attempts should not.

## 12. Priority order

Prefer, in order:

1. exact targeted search;
2. small matched snippet;
3. symbol outline;
4. narrow source range;
5. narrow Tree-sitter structural query for a known symbol/file;
6. targeted local read of an already identified file;
7. minified file content when necessary;
8. complete file only when genuinely required;
9. shallow tree only when orientation cannot be obtained from the user's clue or targeted search.

The governing rule is: **load only information that changes the next decision.**