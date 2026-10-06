# dsh-diff-viewer

A DeepSeek Harness plugin that shows the current project's `git diff` in the
**right sidebar**. Both the entry point and the view live in the right column:
the tab-add ("+") guide lists **Diff Viewer**, and choosing it opens a new tab
whose body reads the session's working tree.

When `<session cwd>/.git` exists, the tab shows the working tree's changes
against `HEAD` — staged and unstaged together — and the untracked files, whose
contents are read and presented too. When it does not, the tab shows the **Not a
git project** state instead. All visible text goes through the client locale
service, which ships an English and a Chinese dictionary.

Open it from the right sidebar's **+** guide, which shows its **⌘D** keycap
(`Ctrl+D` on Windows and Linux), or press that key directly. Either way, if the
tab is already open it is focused rather than duplicated.

## What it looks like

| State | Body |
|---|---|
| git repository | Branch, short HEAD, repo root, `+additions/-deletions`, one collapsible section per file marked `+`/`-`/`*`, with hunks and line numbers |
| tracked change | That file's hunks against `HEAD` |
| untracked file | Its whole contents as one all-additions hunk, marked `+` with a dashed border; tracked changes are listed first, untracked files after |
| file it cannot show | A one-line reason instead of hunks: binary, empty, over the preview cap, unreadable, or skipped by the untracked budget |
| clean tree | "The working tree has no changes." |
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
| `test/client.mjs` | Browser-half checks that render the bundle without React |

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

That reload re-runs the bundle's factory **in place**, and the style tag it
installed on the first load survives. Installing the stylesheet only when no tag
exists would therefore pin whichever CSS the first load happened to carry, and
every later edit would apply to nothing until a full page refresh. The bundle
updates an existing tag instead, which `test/client.mjs` pins.

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

**The file mark.** A file row is marked by its change kind, one mark in a
centred 16px square before the name, because a sidebar heading has no room for a
word: `+` for added, untracked, and copied files, `-` for deleted ones, and `*`
for modified, renamed, and conflicted ones.

The three marks are **drawn as SVG paths**, not typed. A text glyph is placed by
the font's baseline and side bearings rather than by its own ink, so centring the
line box leaves the visible mark off-centre — render `+`, `-`, and `*` in a
square and the plus sits left and low while the asterisk rides well above the
middle. No single CSS nudge fixes three differently-offset glyphs, and the
offsets change with the font. Paths on a 10×10 grid put every mark exactly on the
centre and give the three the same weight whatever font the page loads.

The colour follows the mark — green adds, red deletes, amber changes — so a mark
means the same thing on every row. The rule selects on the mark rather than the
status, which is what keeps renamed and conflicted from drifting away from
modified when all three draw a star, and the precise status rides alongside for
the one thing the mark cannot say: an untracked file draws a dashed border. The
mark's tooltip names its status in the active locale, and the row's accessible
name is that word plus the path — a bare mark is not a name.

**The disclosure triangle.** The row's expand arrow is drawn on the same 10×10
grid, and is one path used twice: the expanded state is the same triangle turned
a quarter turn about the grid centre, so the two cannot drift apart. It replaces
the `▸`/`▾` glyph pair, which rendered as a sliver at any font size small enough
to fit the row.

**One tab, not many.** The type is registered `multiple: false`. A
multi-instance type mints a fresh address per open (`<page>/<uuid>`), so every
open adds another tab; a single address instead lets the owner's own
`revealIfOpened` path find the open tab and focus it. That is what makes both the
guide entry and the shortcut converge on one tab, and it is why `multiple` is
load-bearing rather than cosmetic.

**The shortcut is desktop-only.** `ctx.shortcuts` validates every runtime and
platform pair at registration, not just the running one, and a browser owns
Cmd/Ctrl+D as bookmark: a single primary modifier is admitted for Web only on
Comma and Backslash. A declared Web default would therefore throw
`Unsupported Web shortcut` and take the whole plugin down. Only the three
desktop profiles are declared, and the key is `primary` rather than `meta` so it
follows the platform — Command on macOS, Control elsewhere. The guide entry names
the command through `commandId`, which is what makes the column draw those same
keys on the entry and set them as its `aria-keyshortcuts`; an id matching no
command would lose the hint silently, so the client check ties the two together. The resolver asks
`ctx.sidebarRight.commandTarget` for the focused pane and falls back to the
mounted session, so the key works from the composer too, and reports a blocked
command rather than throwing when no session is mounted.

**Type scale.** Every size in the panel derives from one local scale, and the
scale is fixed: the diff reads at one size however the conversation is set.
`--dsh-diff-code` is the single number (14px); `--dsh-diff-meta` is the chrome's
own name for that same size, so the toolbar, the counts, and the notices read at
it too; `micro` is two pixels under it for the small chips; and the gutter, the
marks, and the glyph boxes are sized to match. Changing that one number resizes
the whole panel, text and geometry together.

The panel deliberately does **not** read `--dsh-content-font-size`, the
preference the theme publishes on the body for Settings → Font size. Following it
would make the sidebar's diff resize with a setting labelled as affecting
conversation content only.

**Untracked files.** git reports these as paths only, so the Host reads each one
and builds the all-additions hunk git would have produced. The read is bounded:
512 KiB per file, 4 MiB and 400 files per collection. A file past a cap is
*refused*, not truncated — half a file under plausible line numbers is worse
than an honest reason — and every untracked path still appears in the list with
its `note` set to `binary`, `large`, `unreadable`, or `omitted`. An empty file is
none of those: it reports `empty-file` and nothing else.

**Bounded work.** stdout is collected under an 8 MiB cap (a larger patch is
reported as truncated), stderr under 256 KiB, and the whole collection is
abandoned after 20 s or when the client disconnects. git runs with
`GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0`, and `LC_ALL=C` so it can never
block on a credential prompt, take the index lock, or emit localized output.

**Rendering.** Pushes are parsed host-side into hunks carrying per-line numbers,
so the browser does no diff parsing and no number arithmetic. Each hunk line
carries `oldLine`, `newLine`, and the `number` the viewer prints, resolved by the
Host: a deletion is cited by its old-side number and everything else by its
new-side one. Putting that choice on the side that owns the diff means the client
only prints a field, and the Host's own tests cover which number each line kind
carries.

Each line draws **one** number, not two: a two-column gutter is half empty on
every line it draws — the old-side cell on an addition, the new-side cell on a
deletion — so in a sidebar panel most of the leading width would be spent on
nothing. The row's add/delete tint runs under the gutter instead of stopping at
it, so the leading edge is part of the change rather than a blank band.

Lines are inset from both panel edges, and a long line **wraps** rather than
scrolling sideways: the panel is narrow, and a horizontal scrollbar in it hides
more than it reveals. `white-space:pre-wrap` keeps each line's own indentation
while wrapping, and `overflow-wrap:anywhere` breaks the unbroken tokens —
minified JavaScript, long URLs — that would otherwise still overflow. Files start
collapsed when a diff exceeds 1200 lines, and no single file renders more than
2500 lines.

## Test

```
node test/smoke.mjs       # git collection and unified-diff parsing
node test/host-route.mjs  # the HTTP route, end to end
node test/client.mjs      # the browser half, rendered
```

`smoke.mjs` builds throwaway repositories in the OS temp directory and
exercises the parser and the collector: clean, dirty, staged, untracked with
contents, unborn, binary, renamed, quoted paths, CRLF, a file with no final
newline, an empty file, a file past the preview cap, an unreadable file, the
untracked budget, a directory with no `.git`, and a missing git executable.

`host-route.mjs` mounts `lib/index.js` on a stub Cordis context whose
`subprocess` runs real git, then drives the registered handler with fake
request/response objects: an authorized diff, the `?path=` override, the
non-git project state, the missing-directory 404, the sandbox-policy fallback,
the authorization fence, and the 405 for a non-GET method.

`client.mjs` loads `lib/client.js` through a stub `__ModuleLoader__` and a stub
`require`, then renders the presentational pieces the bundle exposes as a test
seam — no React, no DOM. It covers what the Host's own tests cannot: a
host/client field-name mismatch leaves the payload perfectly correct while the
panel draws blank, which is exactly how the line-number gutter once rendered
empty on every line. It asserts that each hunk line's number and side reach the
gutter, that signs, row tints, hunk headers, and untracked contents are drawn,
that a collapsed block draws no hunk, and that each `note` renders an
explanation instead of nothing.
