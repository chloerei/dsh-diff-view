# dsh-diff-viewer

A DeepSeek Harness plugin that shows the current project's `git diff` in the
**right sidebar**. Both the entry point and the view live in the right column:
the tab-add ("+") guide lists **Git diff**, and choosing it opens a new tab
whose body reads the session's working tree.

When `<session cwd>/.git` exists, the tab shows the working tree's changes
against `HEAD` — staged and unstaged together — plus the untracked files. When
it does not, the tab shows the **Not a git project** state instead. All visible
text goes through the client locale service, which ships an English and a
Chinese dictionary.

## What it looks like

| State | Body |
|---|---|
| git repository | Branch, short HEAD, repo root, `+additions/-deletions`, one collapsible section per file with status badge, hunks, and old/new line numbers |
| clean tree | "The working tree has no changes." |
| untracked only | The same summary plus an untracked-files list |
| no `.git` | "Not a git project" with the inspected directory |
| git missing or failing | The error text and a retry button |

## Files

| Path | Role |
|---|---|
| `package.json` | Bundle + `dsh.client` manifest (`.`, `./client`, bundle patch) |
| `cordis.patch.yml` | The bundle layer: one `insert` row named `dsh-diff-viewer` |
| `lib/index.js` | Host half: the read-only `GET /dsh-diff-viewer/diff` route |
| `lib/git-diff.js` | Host half: pure git collection and unified-diff parsing |
| `lib/client.js` | Browser half: the `git-diff` tab type and its body |
| `test/smoke.mjs` | Host-half checks against throwaway repositories |
| `test/host-route.mjs` | Host-half checks that drive the registered route |

Both halves are plain, hand-written JavaScript. No build step, no bundler, no
runtime dependency: the browser artifact is the `window.__ModuleLoader__.load`
CJS-factory form that the Harness client serves verbatim, and it draws only with
`react` and theme CSS variables.

## Install

The installer takes an **absolute** path to this package directory — relative
paths are rejected:

```
dsh plugin --profile desktop add /absolute/path/to/dsh-diff-viewer
```

From the package root, `"$PWD"` expands to that path:
`dsh plugin --profile desktop add "$PWD"`.

Equivalently, install it through the agent's `plugin_manager` tool with
`action: install_bundle` and this directory as `target`. Either route records a
`link:` dependency in the profile and appends `dsh-diff-viewer` to
`dsh.profile.bundles`, so the bundle patch supplies the row.

Then open a session and use **+** in the right sidebar's tab strip.

### After a code edit

The two halves reload differently.

**`lib/client.js` — live, no restart.** `dsh-client-hmr` polls every registered
client bundle (500 ms by default) and watches the files `dsh-client-modules`
advertises. A changed byte makes the Host publish a `rebuilt` frame on its
`/plugins/events` stream, and the open page swaps the module in place; reopening
the tab is enough.

**`lib/index.js` and `lib/git-diff.js` — restart.** The profile's HMR watches
composition files (`package.json`, `cordis.patch.yml`), not host module source,
and the loader imports host halves with a plain `import()` and no cache-busting
URL. Toggling the bundle off and on re-runs its lifecycle but still hands back
the already-imported module generation, so an application restart is the
reliable answer.

## Design notes

**Why an HTTP route rather than a Remote namespace.** A third-party package
cannot add a `ctx.remote.<namespace>`: the typert faces are
`@deepseek-ai/dsh-typert-generator` output (not shipped), and the browser roster
in `dsh-api-remotes` is a fixed list. A single same-origin route is the shipped
precedent (`dsh-host-open-in-app`), needs no code generation, and keeps the
whole surface read-only.

**Authorization.** The handler calls `ctx.connection.requestRejection(req)`
first, exactly as the shipped route does, so the Harness Host/Origin fence and
the browser cookie both apply. Only `GET` is answered.

**Working directory.** `lib/index.js` resolves, in order: an explicit `?path=`
query, the live `ctx.sessions` header, the persisted session header, then
`ctx.sandboxPolicy.workspaceRoot`.

**Repository root.** `.git` presence at the session directory is the whole test,
exactly as specified: a project nested inside someone else's repository is not
claimed as that repository. When `.git` is present the collector still probes
`git rev-parse --show-toplevel` and runs every later command there, so a linked
worktree or submodule reports repository-relative paths.

**Bounded work.** stdout is collected under an 8 MiB cap (a larger patch is
reported as truncated), stderr under 256 KiB, and the whole collection is
abandoned after 20 s or when the client disconnects. git runs with
`GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0`, and `LC_ALL=C` so it can never
block on a credential prompt, take the index lock, or emit localized output.

**Rendering.** Pushes are parsed host-side into hunks with per-line old/new
numbers, so the browser does no diff parsing. Files start collapsed when a diff
exceeds 1200 lines, and no single file renders more than 2500 lines.

## Test

```
node test/smoke.mjs       # git collection and unified-diff parsing
node test/host-route.mjs  # the HTTP route, end to end
```

`smoke.mjs` builds throwaway repositories in the OS temp directory and
exercises the parser and the collector: clean, dirty, staged, untracked,
unborn, binary, renamed, quoted paths, a directory with no `.git`, and a missing
git executable.

`host-route.mjs` mounts `lib/index.js` on a stub Cordis context whose
`subprocess` runs real git, then drives the registered handler with fake
request/response objects: an authorized diff, the `?path=` override, the
non-git project state, the missing-directory 404, the sandbox-policy fallback,
the authorization fence, and the 405 for a non-GET method.
