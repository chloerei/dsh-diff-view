/**
 * Working-tree git diff collection for the dsh-diff-viewer host half.
 *
 * Everything here is transport-free: the caller supplies a `run(args, signal)`
 * function that executes `git` in a directory and resolves with
 * `{ exitCode, stdout, stderr, lossy }`. That keeps the parsing and assembly
 * testable without a live Harness Host.
 *
 * @module dsh-diff-viewer/git-diff
 */

import { existsSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";

/** Context lines kept around each change in the unified patch. */
const CONTEXT_LINES = 3;

/** Largest untracked file whose contents are read for preview. */
const MAX_UNTRACKED_FILE_BYTES = 512 * 1024;

/** Total untracked bytes read for one collection. */
const MAX_UNTRACKED_TOTAL_BYTES = 4 * 1024 * 1024;

/** Largest number of untracked files whose contents are read. */
const MAX_UNTRACKED_FILES = 400;

/** `@@ -oldStart,oldCount +newStart,newCount @@` (the counts are optional). */
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Build one hunk line with a uniform shape.
 *
 * `number` is the number the viewer prints, resolved here rather than in the
 * browser: a deletion is cited by its old-side number and everything else by
 * its new-side one, which is the position a reader quotes after the change.
 * Keeping that decision on the side that owns the diff means the client only
 * has to print a field, and the host's own tests cover which number each line
 * kind carries.
 *
 * @param kind - `add`, `delete`, `context`, or `meta`.
 * @param text - the line's content, without its diff marker.
 * @param oldLine - the old-side number, or null when the line has none.
 * @param newLine - the new-side number, or null when the line has none.
 * @returns the hunk line.
 */
function line(kind, text, oldLine, newLine) {
  const number = kind === "delete" ? oldLine : newLine;
  return { kind, text, oldLine, newLine, number: number ?? null };
}

/**
 * Read one file for preview.
 *
 * A file over the cap is refused rather than truncated: half a file with
 * plausible-looking line numbers is worse than an honest "too large".
 *
 * @param absolutePath - the file to read.
 * @param maxBytes - the largest file this call may read.
 * @returns `{kind: "text", text, bytes, truncated}`,
 *   `{kind: "binary", bytes}`, `{kind: "too-large", bytes}`, or
 *   `{kind: "unreadable"}`.
 */
export async function readTextFile(absolutePath, maxBytes) {
  let handle;
  try {
    handle = await open(absolutePath, "r");
  } catch {
    return { kind: "unreadable" };
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return { kind: "unreadable" };
    if (info.size > maxBytes) return { kind: "too-large", bytes: info.size };
    const buffer = Buffer.alloc(info.size);
    await handle.read(buffer, 0, info.size, 0);
    if (buffer.includes(0)) return { kind: "binary", bytes: info.size };
    return { kind: "text", text: buffer.toString("utf8"), bytes: info.size, truncated: false };
  } catch {
    return { kind: "unreadable" };
  } finally {
    await handle.close();
  }
}

/**
 * Present a whole file as one all-additions hunk, the shape an untracked file
 * would have in a diff.
 *
 * @param text - the file's decoded text.
 * @returns one hunk, or none for an empty file.
 */
export function hunksFromText(text) {
  if (text === "") return [];
  const terminated = text.endsWith("\n");
  const lines = text.split("\n");
  if (terminated) lines.pop();
  const hunkLines = lines.map((text, index) => line("add", text.endsWith("\r") ? text.slice(0, -1) : text, null, index + 1));
  if (!terminated) hunkLines.push(line("meta", "No newline at end of file", null, null));
  return [{ header: `@@ -0,0 +1,${String(lines.length)} @@`, lines: hunkLines }];
}

/**
 * Strip one git `a/` or `b/` prefix from a patch path.
 * @param value - the raw path field of a `---`/`+++` line.
 * @returns the repository-relative path, or null for `/dev/null`.
 */
export function stripPatchPrefix(value) {
  const path = unquotePath(value.trim());
  if (path === "/dev/null") return null;
  return path.startsWith("a/") || path.startsWith("b/") ? path.slice(2) : path;
}

/**
 * Undo git's C-style quoting of a path. `core.quotepath=false` already avoids
 * octal escapes, but a path containing a quote or a newline is still quoted.
 * @param value - the possibly quoted path.
 * @returns the unquoted path.
 */
export function unquotePath(value) {
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) return value;
  const body = value.slice(1, -1);
  try {
    return JSON.parse(value);
  } catch {
    return body.replace(/\\(.)/g, "$1");
  }
}

/**
 * Recover a path from a `diff --git a/x b/y` header when the file has no
 * `+++` line (mode-only changes and binary stubs can omit it).
 * @param hint - everything after `diff --git `.
 * @returns the best-effort path.
 */
function pathFromDiffHeader(hint) {
  const index = hint.lastIndexOf(" b/");
  return index === -1 ? unquotePath(hint) : stripPatchPrefix(hint.slice(index + 1));
}

/**
 * Parse one unified patch into per-path hunks.
 *
 * The parser is deliberately forgiving: unknown header lines are ignored
 * rather than treated as errors, so a git version that adds a header line does
 * not break the view.
 *
 * @param text - the complete `git diff` output.
 * @returns a Map of repository-relative path to `{ hunks, binary, status, previousPath }`.
 */
export function parseUnifiedPatch(text) {
  const files = new Map();
  let current = null;
  let hunk = null;
  let oldLine = 0;
  let newLine = 0;

  const flush = () => {
    if (current === null) return;
    const path = current.path ?? pathFromDiffHeader(current.hint ?? "");
    if (path !== null && path !== "") {
      current.hunks = current.hunks.map((entry) => ({
        header: entry.header,
        lines: entry.lines,
      }));
      files.set(path, current);
    }
    current = null;
    hunk = null;
  };

  for (const raw of text.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      flush();
      current = { path: null, previousPath: null, hint: raw.slice(11), hunks: [], binary: false, status: "modified" };
      continue;
    }
    if (current === null) continue;
    if (raw === "") continue;
    if (raw.startsWith("--- ")) {
      const from = stripPatchPrefix(raw.slice(4));
      if (from !== null) current.previousPath = from;
      continue;
    }
    if (raw.startsWith("+++ ")) {
      const to = stripPatchPrefix(raw.slice(4));
      if (to !== null) current.path = to;
      continue;
    }
    if (raw.startsWith("new file mode")) {
      current.status = "added";
      continue;
    }
    if (raw.startsWith("deleted file mode")) {
      current.status = "deleted";
      continue;
    }
    if (raw.startsWith("rename from ")) {
      current.previousPath = unquotePath(raw.slice(12));
      current.status = "renamed";
      continue;
    }
    if (raw.startsWith("rename to ")) {
      current.path = unquotePath(raw.slice(10));
      current.status = "renamed";
      continue;
    }
    if (raw.startsWith("copy from ")) {
      current.previousPath = unquotePath(raw.slice(10));
      current.status = "copied";
      continue;
    }
    if (raw.startsWith("copy to ")) {
      current.path = unquotePath(raw.slice(8));
      current.status = "copied";
      continue;
    }
    if (raw.startsWith("Binary files ") || raw.startsWith("GIT binary patch")) {
      current.binary = true;
      continue;
    }
    if (raw.startsWith("old mode") || raw.startsWith("new mode") || raw.startsWith("index ") || raw.startsWith("similarity index") || raw.startsWith("dissimilarity index")) continue;

    const header = HUNK_HEADER.exec(raw);
    if (header !== null) {
      oldLine = Number(header[1]);
      newLine = Number(header[3]);
      hunk = { header: raw, lines: [] };
      current.hunks.push(hunk);
      continue;
    }
    if (hunk === null) continue;

    const marker = raw[0];
    if (marker === "\\") {
      hunk.lines.push(line("meta", raw.slice(1).trim(), null, null));
      continue;
    }
    if (marker === "+") {
      hunk.lines.push(line("add", raw.slice(1), null, newLine));
      newLine += 1;
      continue;
    }
    if (marker === "-") {
      hunk.lines.push(line("delete", raw.slice(1), oldLine, null));
      oldLine += 1;
      continue;
    }
    if (marker === " ") {
      hunk.lines.push(line("context", raw.slice(1), oldLine, newLine));
      oldLine += 1;
      newLine += 1;
    }
  }
  flush();
  return files;
}

/**
 * Parse `git status --porcelain=v1 -z` into per-path index/worktree codes.
 *
 * In `-z` form a rename or copy prints its two paths as two NUL-terminated
 * fields, so the origin field is consumed and the destination owns the entry.
 *
 * @param text - the raw `-z` output.
 * @returns a Map of path to `{ index, worktree }`.
 */
export function parseStatusEntries(text) {
  const fields = text.split("\0");
  const entries = new Map();
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i];
    if (field.length < 4) continue;
    const index = field[0];
    const worktree = field[1];
    const path = field.slice(3);
    if (index === "R" || index === "C" || worktree === "R" || worktree === "C") i += 1;
    entries.set(path, { index, worktree });
  }
  return entries;
}

/**
 * Parse `git diff --numstat -z` into per-path line counts.
 * @param text - the raw `-z` output.
 * @returns a Map of path to `{ additions, deletions, binary }`.
 */
export function parseNumstat(text) {
  const fields = text.split("\0");
  const stats = new Map();
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i];
    if (field === "") continue;
    const first = field.indexOf("\t");
    const second = first === -1 ? -1 : field.indexOf("\t", first + 1);
    if (second === -1) continue;
    const additions = field.slice(0, first);
    const deletions = field.slice(first + 1, second);
    let path = field.slice(second + 1);
    if (path === "") {
      path = fields[i + 2] ?? "";
      i += 2;
    }
    if (path === "") continue;
    const binary = additions === "-" || deletions === "-";
    stats.set(path, {
      additions: binary ? 0 : Number(additions),
      deletions: binary ? 0 : Number(deletions),
      binary,
    });
  }
  return stats;
}

/**
 * Turn one porcelain code pair into the view's status vocabulary.
 * @param entry - the `{ index, worktree }` codes.
 * @returns status plus the staged/unstaged/conflicted/untracked facts.
 */
export function describeStatus(entry) {
  const index = entry?.index ?? " ";
  const worktree = entry?.worktree ?? " ";
  const untracked = index === "?" || worktree === "?";
  const conflicted = index === "U" || worktree === "U" || (index === "A" && worktree === "A") || (index === "D" && worktree === "D");
  let status = "modified";
  if (conflicted) status = "conflicted";
  else if (untracked) status = "untracked";
  else if (index === "R" || worktree === "R") status = "renamed";
  else if (index === "A" || worktree === "A") status = "added";
  else if (index === "D" || worktree === "D") status = "deleted";
  else if (index === "C" || worktree === "C") status = "copied";
  return {
    status,
    staged: index !== " " && index !== "?",
    unstaged: worktree !== " " && worktree !== "?",
    conflicted,
    untracked,
  };
}

/**
 * Whether a directory holds a git administrative entry.
 *
 * A linked worktree or a submodule records `.git` as a file, so existence —
 * not directory-ness — is the test, matching what the user asked for.
 *
 * @param cwd - the directory to test.
 * @returns true when `.git` exists.
 */
export function hasGitEntry(cwd) {
  try {
    return existsSync(join(cwd, ".git"));
  } catch {
    return false;
  }
}

/**
 * Collect the working tree's diff against HEAD.
 *
 * The result is a plain JSON-serializable object; the caller decides how to
 * carry it. A directory with no `.git` entry returns `state: "no-git"` rather
 * than an error, because that is a normal thing for a project directory to be —
 * and the check is exactly that entry, so a project nested inside someone
 * else's repository is not silently reported as its own.
 *
 * Once `.git` is present the repository root is resolved and every git call
 * runs there, so paths are repository-relative and a linked worktree behaves
 * like the repository it belongs to.
 *
 * @param options - collection inputs.
 * @param options.run - `(args, signal, cwd) => Promise<{ exitCode, stdout, stderr, lossy }>`.
 * @param options.cwd - the session's working directory.
 * @param options.signal - aborts every git invocation.
 * @param options.readFile - how untracked contents are read; defaults to the
 *   filesystem, and tests replace it to exercise the size and error branches.
 * @returns the diff payload.
 */
export async function collectWorkingTreeDiff({ run, cwd, signal, readFile = readTextFile }) {
  if (!hasGitEntry(cwd)) {
    return {
      state: "no-git",
      cwd,
      message: "This project has no .git directory, so there is no git diff to show.",
    };
  }
  const probe = await runGit(run, cwd, ["rev-parse", "--show-toplevel"], signal, {});
  const root = probe.exitCode === 0 && probe.stdout.trim() !== "" ? probe.stdout.trim() : cwd;

  const version = await runGit(run, root, ["--version"], signal, {});
  const head = await runGit(run, root, ["rev-parse", "--verify", "--short", "HEAD"], signal, {});
  const branchName = await runGit(run, root, ["branch", "--show-current"], signal, {});
  const branch = (branchName.stdout.trim() || (await runGit(run, root, ["rev-parse", "--abbrev-ref", "HEAD"], signal, {})).stdout.trim()) || null;

  const hasHead = head.exitCode === 0 && head.stdout.trim() !== "";
  const base = hasHead ? ["HEAD"] : [];

  const statusResult = await runGit(run, root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], signal, { required: true });
  const numstatResult = await runGit(run, root, ["diff", ...base, "--numstat", "-z"], signal, {});
  const patchResult = await runGit(run, root, ["diff", ...base, "--no-color", "--no-ext-diff", `-U${String(CONTEXT_LINES)}`], signal, {});
  let patchText = patchResult.stdout;
  if (!hasHead) {
    const staged = await runGit(run, root, ["diff", "--cached", "--no-color", "--no-ext-diff", `-U${String(CONTEXT_LINES)}`], signal, {});
    patchText = [staged.stdout, patchText].filter((part) => part !== "").join("\n");
  }

  const statuses = parseStatusEntries(statusResult.stdout);
  const stats = parseNumstat(numstatResult.stdout);
  const patches = parseUnifiedPatch(patchText);

  const paths = new Set([...patches.keys(), ...statuses.keys()]);
  const tracked = [];
  const untrackedPaths = [];
  for (const path of paths) {
    const described = describeStatus(statuses.get(path));
    if (described.untracked) {
      untrackedPaths.push(path);
      continue;
    }
    const patch = patches.get(path);
    const stat = stats.get(path);
    const status = patch !== undefined && patch.status !== "modified" ? patch.status : described.status;
    const binary = patch?.binary === true || stat?.binary === true;
    const hunks = patch?.hunks ?? [];
    tracked.push({
      path,
      previousPath: patch?.previousPath ?? null,
      status,
      staged: described.staged,
      unstaged: described.unstaged,
      conflicted: described.conflicted,
      binary,
      note: binary ? "binary" : hunks.length === 0 ? "empty" : null,
      additions: stat?.additions ?? countLines(hunks, "add"),
      deletions: stat?.deletions ?? countLines(hunks, "delete"),
      hunks,
    });
  }
  tracked.sort((left, right) => left.path.localeCompare(right.path));

  untrackedPaths.sort((left, right) => left.localeCompare(right));
  const untracked = await readUntrackedFiles({ readFile, root, paths: untrackedPaths });

  return {
    state: "ok",
    cwd,
    root,
    gitVersion: version.stdout.trim() || null,
    branch,
    detached: branch === null || branch === "HEAD",
    head: hasHead ? head.stdout.trim() : null,
    unborn: !hasHead,
    truncated: patchResult.lossy === true,
    counts: {
      files: tracked.length + untracked.length,
      tracked: tracked.length,
      untracked: untracked.length,
      additions: tracked.reduce((total, file) => total + file.additions, 0) + untracked.reduce((total, file) => total + file.additions, 0),
      deletions: tracked.reduce((total, file) => total + file.deletions, 0),
    },
    /* Tracked changes first, then the untracked tail — how `git status` groups them. */
    files: [...tracked, ...untracked],
  };
}

/**
 * Read the untracked files so the viewer can show their contents.
 *
 * Every entry is reported even when its contents are not: a file the viewer
 * cannot show still has to appear, with the reason attached.
 *
 * @param options - the reader, the repository root, and the paths to read.
 * @param options.readFile - `(absolutePath, maxBytes) => Promise<read result>`.
 * @param options.root - the repository root the paths are relative to.
 * @param options.paths - repository-relative untracked paths, pre-sorted.
 * @returns one file record per path.
 */
async function readUntrackedFiles({ readFile, root, paths }) {
  const files = [];
  let spent = 0;
  for (const path of paths) {
    const entry = {
      path,
      previousPath: null,
      status: "untracked",
      staged: false,
      unstaged: true,
      conflicted: false,
      binary: false,
      note: null,
      additions: 0,
      deletions: 0,
      hunks: [],
    };
    files.push(entry);
    if (files.length > MAX_UNTRACKED_FILES || spent >= MAX_UNTRACKED_TOTAL_BYTES) {
      entry.note = "omitted";
      continue;
    }
    const allowance = Math.min(MAX_UNTRACKED_FILE_BYTES, MAX_UNTRACKED_TOTAL_BYTES - spent);
    const read = await readFile(join(root, path), allowance);
    if (read.kind === "text") {
      entry.hunks = hunksFromText(read.text);
      entry.additions = entry.hunks.reduce((total, hunk) => total + hunk.lines.filter((line) => line.kind === "add").length, 0);
      /* An empty new file is not a metadata-only change; say what it is. */
      entry.note = read.text === "" ? "empty-file" : null;
      spent += read.bytes;
      continue;
    }
    if (read.kind === "binary") {
      entry.binary = true;
      entry.note = "binary";
      spent += read.bytes;
      continue;
    }
    entry.note = read.kind === "too-large" ? "large" : "unreadable";
  }
  return files;
}

/**
 * Count one hunk-line kind, used when `--numstat` has no row for a path.
 * @param hunks - the file's hunks.
 * @param kind - `add` or `delete`.
 * @returns the number of matching lines.
 */
function countLines(hunks, kind) {
  if (hunks === undefined) return 0;
  let total = 0;
  for (const hunk of hunks) for (const line of hunk.lines) if (line.kind === kind) total += 1;
  return total;
}

/**
 * Run one git command and normalize its outcome.
 * @param run - the caller's executor.
 * @param cwd - the directory git runs in.
 * @param args - arguments after the `git` program name.
 * @param signal - abort signal.
 * @param options - `required` throws instead of returning a failed result.
 * @returns `{ exitCode, stdout, stderr, lossy }`.
 */
async function runGit(run, cwd, args, signal, options) {
  const result = await run(args, signal, cwd);
  if (options.required === true && result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new Error(`git ${args.join(" ")} failed in ${cwd}${detail === "" ? "" : `: ${detail}`}`);
  }
  return result;
}
