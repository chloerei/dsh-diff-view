# dsh-diff-view

A DeepSeek Harness plugin that shows the current project's `git diff` in the
**right sidebar**. Both the entry point and the view live in the right column:
the tab-add ("+") guide lists **Diff View**, and choosing it opens a new tab
whose body reads the session's working tree.

When `<session cwd>/.git` exists, the tab shows the working tree's changes
against `HEAD` — staged and unstaged together — and the untracked files, whose
contents are read and presented too. When it does not, the tab shows the **Not a
git project** state instead. All visible text goes through the client locale
service, which ships an English and a Chinese dictionary.

The panel is **live**: while it is open and on screen it updates itself when the
diff changes — an agent editing a file, a new file appearing, a commit or a
checkout — and it does that without polling the working tree or re-reading the
diff on a timer. See [Auto-refresh](#auto-refresh) for how, and for what it
costs when nothing is happening.

Open it from the right sidebar's **+** guide, which shows its **⌘D** keycap
(`Ctrl+D` on Windows and Linux), or press that key directly. Either way, if the
tab is already open it is focused rather than duplicated.

## What it looks like

| State | Body |
|---|---|
| git repository | Branch, short HEAD, repo root, `+additions/-deletions`, one collapsible section per file marked `+`/`-`/`*`, with hunks and a two-column line-number gutter, plus one toolbar toggle that opens or closes every file |
| tracked change | That file's hunks against `HEAD` |
| untracked file | Its whole contents as one all-additions hunk, marked `+` with a dashed border; tracked changes are listed first, untracked files after |
| file it cannot show | A one-line reason instead of hunks: binary, empty, over the preview cap, unreadable, or skipped by the untracked budget |
| clean tree | "The working tree has no changes." |
| no `.git` | "Not a git project" with the inspected directory |
| git missing or failing | The error text and a retry button |
| the diff changes | The panel redraws itself in place; a file's expanded state survives the update |

## Files

| Path | Role |
|---|---|
| `package.json` | Bundle + `dsh.client` manifest (`.`, `./client`, bundle patch) |
| `cordis.patch.yml` | The bundle layer: one `insert` row named `dsh-diff-view` |
| `lib/index.js` | Host half: the read-only `GET /dsh-diff-view/diff` route and the `GET /dsh-diff-view/events` stream |
| `lib/git-diff.js` | Host half: pure git collection, the change fingerprint, and unified-diff parsing |
| `lib/diff-watch.js` | Host half: when a change is worth collecting, and which directories to watch |
| `lib/client.js` | Browser half: the `dsh-diff-view` tab type, its body, and its subscription |
| `test/smoke.mjs` | Host-half checks against throwaway repositories |
| `test/watch.mjs` | Host-half checks for the change detector, over fakes |
| `test/host-route.mjs` | Host-half checks that drive the registered routes |
| `test/client.mjs` | Browser-half checks that render the bundle without React |

Both halves are plain, hand-written JavaScript. No build step, no bundler, no
runtime dependency: the browser artifact is the `window.__ModuleLoader__.load`
CJS-factory form that the Harness client serves verbatim, and it draws only with
`react` and theme CSS variables.

## Install

The installer takes an **absolute** path to this package directory — relative
paths are rejected:

```
dsh plugin --profile desktop add /absolute/path/to/dsh-diff-view
```

From the package root, `"$PWD"` expands to that path:
`dsh plugin --profile desktop add "$PWD"`.

Equivalently, install it through the agent's `plugin_manager` tool with
`action: install_bundle` and this directory as `target`. Either route records a
`link:` dependency in the profile and appends `dsh-diff-view` to
`dsh.profile.bundles`, so the bundle patch supplies the row.

Then open a session and use **+** in the right sidebar's tab strip.

### After a code edit

The two halves reload differently.

**`lib/client.js` — live, no restart.** `dsh-client-hmr` stat-polls the bundle
artifact `dsh-client-modules` reports for every graph row (500 ms by default). A
changed artifact makes the Host publish a `rebuilt` frame on its `/plugins/events`
stream, and the open page swaps the module in place; reopening the tab is enough.

That reload re-runs the bundle's factory against the same page, and the Harness
owns the `<style>` tags a factory injects: `dsh-client-modules` claims them for
the plugin that made them and removes them when it replaces that plugin's module
— `removeOwnedStyles` runs after the old fiber is torn down and before the bundle
is imported — so a reload normally starts with no tag of this plugin's on the
page. The bundle writes unconditionally either way: it refreshes an existing tag
in place when one is there, and appends one when it is not, so the stylesheet can
never be a generation behind. `test/client.mjs` drives both paths.

**`lib/index.js`, `lib/git-diff.js`, and `lib/diff-watch.js` — restart.** The
profile's HMR runs with `root: []`, so it watches composition files
(`package.json`, `cordis.patch.yml`) and not host module source: an edit under
`lib/` raises no reload at all. Toggling the bundle off and on re-runs the row's
lifecycle, but the module `import()` the Loader already performed is still in its
cache, so it hands back the old host half just the same. An application restart
is the reliable answer.

That ordering is survivable rather than a trap for the event stream: a browser
half that finds no `GET /dsh-diff-view/events` on the Host it is talking to
falls back to reading the diff route every 20 s, so auto-refresh is slow but
present until the restart, and immediate afterwards.

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

**The all-files toggle.** The toolbar's one control is an icon button that opens
or closes every file at once. It reads the same per-file open state the carets
drive and always states the *other* action: with every file open it offers to
collapse, with anything closed it offers to expand. A clean tree draws no toggle,
because there is nothing to open. The glyph is drawn rather than typed — two
chevrons pointing outward to expand and inward to collapse, the
unfold-more/unfold-less pair a reader already knows, on the same stroke weight as
the caret so neither looks heavier than the other.

Its answer is the **panel's**, not a snapshot of the paths that were on screen
when it was pressed: once used it stands in for the size rule on every path the
reader has not ruled on individually, so a file that only turns up in a later
payload opens or stays shut the way the button said rather than by the line count
it happened to arrive with. That is also why using it drops the per-file answers
it overrides — leaving them would contradict the panel and make "expand all" a
lie for a file the reader had closed by hand. Pressing a row's own caret
afterwards is a per-path answer again, on top of the panel's.

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

**Type scale.** Every size in the panel comes from one local scale, and the
scale is fixed: the diff reads at one size however the conversation is set.
`--dsh-diff-code` is the base text number (14px) and `--dsh-diff-meta` is the
chrome's own name for that same size, so the toolbar, the counts, and the notices
read at it too; `--dsh-diff-strong` is the one step above it, for an empty
state's title. The geometry keeps its own fixed numbers, chosen to match rather
than derived: `--dsh-diff-caret`, `--dsh-diff-mark`, `--dsh-diff-box`, and
`--dsh-diff-gutter`. Changing the text size alone therefore leaves the gutter and
the marks where they are.

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

<a id="auto-refresh"></a>
**Auto-refresh.** The panel subscribes to `GET /dsh-diff-view/events`, a
server-sent event stream, and the Host's half of that subscription is a
detector per working directory, shared by every viewer of it. The design is one
cost argument, and every part of it is there to keep a quiet working tree free:

- A **check** runs a *fingerprint*, not a diff: one `git status` and one `stat`
  per changed path, capped at 400 paths. It never builds a patch and never reads
  a file's contents. The per-path stamps are what make it honest — a content edit
  to a file that is already dirty leaves the porcelain output byte for byte
  identical, so nothing but the file's own mtime and size can carry that change.
- A **collection** — the full diff — runs only when the fingerprint moved. Its
  result is compared with the one the viewers hold, so a change that does not
  alter what the panel draws never becomes a frame.
- **Directory watches** shorten the wait; they do not raise a payload. Each
  payload re-arms them over the session directory, the repository root, its
  administrative directory, and the parent directories of the changed files —
  sorted and capped, so a large refactor cannot turn into hundreds of watches.
  Watching a directory reports content changes of the files inside it, which is
  what makes an agent's next edit arrive in well under a second.
- A burst of events is **debounced** into one check (300 ms), and a directory
  that never stops churning is held to one check a second. A log file, a
  `.DS_Store`, or a lock file written over and over inside a watched directory
  can therefore never buy more than one fingerprint a second — and a fingerprint
  that comes back unchanged buys nothing at all.
- **Idle** is a fingerprint every 15 s, doubling to a minute while the tree
  stays still, which is what catches a change in a directory nothing is watching
  yet. The stream carries a keep-alive comment every 25 s.
- **With no viewer there is nothing at all**: no timer, no watch, no git
  process. The detector is created by the first stream connection and torn down
  by the last, and the browser half closes that connection while the page is
  hidden — a backgrounded panel costs nothing.
- A payload larger than 512 KiB is announced rather than pushed, and the panel
  re-reads the route; a diff that big is not worth holding in an event stream.

**Ignored paths never enter the view.** `git status` is asked without
`--ignored`, so `.gitignore`, `.git/info/exclude`, and the global excludes file
all apply: build output, logs, and dependencies are absent from the file list,
and the untracked preview never reads them. The *watches* are not ignore-aware —
the filesystem service reports an event without a path — but that only ever
costs a fingerprint, because an ignored file moving changes neither the
porcelain output nor any stamped path.

The browser half drops a frame whose diff it already draws, so a push that says
nothing new costs a string compare rather than a redraw of a few thousand lines.
If the stream cannot be established at all — an older Host that does not serve
it, a proxy that eats it — the panel falls back to reading the route itself
every 20 s, and only while the page is visible, rather than going quietly stale.

There is deliberately **no manual refresh**: the stream owns the update, and a
button that re-read the route would only blank the panel back to its loading
state for a refresh already on its way. The toolbar therefore carries the branch
and the root and nothing to press. The two states that have nothing else on
screen keep their own button — retry after a failed read, refresh when there is
no repository — because those are recovery steps, not a second way to poll.

**Rendering.** Pushes are parsed host-side into hunks carrying per-line numbers,
so the browser does no diff parsing and no number arithmetic. Each hunk line
carries `oldLine` and `newLine` as the Host read them — a deletion has an
old-side number and no new-side one, an addition the reverse, and a context line
both. Numbering on the side that owns the diff means the client only prints the
fields it is handed, and the Host's own tests cover which side has a number.

Each line draws **two** numbers, as the built-in review diff's own line does:
the old side first, then the new side, in two fixed columns with the sign and the
text after them, so the numbers line up down a hunk and a half-empty column still
says which side a line belongs to. The line is one CSS grid rather than a flex
row, which is what keeps those columns true across every line whatever the text
does. A changed line takes the built-in file-diff treatment: the row wears
`--dsw-alias-file-diff-added-bg` / `-deleted-bg`, its number cells take the
matching `-gutter` fill and `-marker` colour, and a **3px marker** runs down the
leading edge — the same `inset 3px 0 0` border the built-in draws — so a change
is visible before a single character is read. The marker sits on the old-side
cell, which starts at the panel edge, so it reads as the row's own left border.

Lines are inset from both panel edges, and a long line **wraps** rather than
scrolling sideways: the panel is narrow, and a horizontal scrollbar in it hides
more than it reveals. `white-space:pre-wrap` keeps each line's own indentation
while wrapping, and `overflow-wrap:anywhere` breaks the unbroken tokens —
minified JavaScript, long URLs — that would otherwise still overflow. Files start
collapsed when a diff exceeds 1200 lines — until the toolbar's toggle settles the
question for the whole panel — and no single file renders more than 2500 lines.

A file's heading **sticks** to the top of that scrolling body while its own
hunks pass under it, so a long file keeps naming itself instead of letting the
reader scroll its path out of sight. The heading's fill is opaque and paints
above the lines, and its section bounds it, so the top is handed on as the next
file arrives.

## Test

```
node test/smoke.mjs       # git collection, the fingerprint, and parsing
node test/watch.mjs       # when a change is worth collecting
node test/host-route.mjs  # both routes, end to end
node test/client.mjs      # the browser half, rendered and driven
```

`smoke.mjs` builds throwaway repositories in the OS temp directory and
exercises the parser and the collector: clean, dirty, staged, untracked with
contents, unborn, binary, renamed, quoted paths, CRLF, a file with no final
newline, an empty file, a file past the preview cap, an unreadable file, the
untracked budget, a directory with no `.git`, and a missing git executable. It
also pins the fingerprint: still while the tree is, and moved by a content edit
to an already-dirty file, by staging, by a fresh untracked file, by a commit,
and by `git init` in a directory that had no repository.

`watch.mjs` drives `lib/diff-watch.js` over fakes — a fingerprint the test
moves by hand, a collector that counts its calls, and watches the test fires —
because the property worth asserting is a cost: a working tree nobody is
watching runs nothing at all, an idle tree is probed but never collected, an
event that changes nothing the panel draws costs one probe, a payload already on
screen is never pushed, the watched set follows the payload within its cap, an
unwatchable directory is reported rather than fatal, and the last viewer takes
the timers and the watches with it.

`host-route.mjs` mounts `lib/index.js` on a stub Cordis context whose
`subprocess` runs real git, then drives the registered handlers with fake
request/response objects: an authorized diff, the `?path=` override, the non-git
project state, the missing-directory 404, the sandbox-policy fallback, the
authorization fence, and the 405 for a non-GET method — then the event stream,
which is opened, fed a real change on disk, and closed; unloading the plugin ends
the streams it holds.

`client.mjs` loads `lib/client.js` through a stub `__ModuleLoader__` and a stub
`require`, then renders the presentational pieces the bundle exposes as a test
seam — no React, no DOM — and mounts the tab body on a small hook runtime of its
own. It covers what the Host's own tests cannot: a host/client field-name
mismatch leaves the payload perfectly correct while the panel draws blank, which
is exactly how the line-number gutter once rendered empty on every line. It
asserts that both of each hunk line's numbers reach their own gutter column, that
the line is laid out on two number tracks with the changed rows wearing the
built-in file-diff fill and the 3px leading marker, that signs, row tints, hunk
headers, and untracked contents are drawn, that a collapsed block draws no hunk,
that the toolbar's one toggle closes every file and opens them again while
stating the action it offers, that its answer also covers a path which only
arrives with the next payload and outranks a file closed by hand, and that each
`note` renders an explanation instead of nothing.
For auto-refresh it asserts that a pushed diff replaces what the panel draws
without a second read, that a payload already on screen is not redrawn, that a
`changed` notice re-reads the route, that a failed stream hands over to the slow
poll, and that a hidden page drops its subscription.
