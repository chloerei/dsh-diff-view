/**
 * Smoke test for the host half's git collection.
 *
 * Builds a throwaway repository, fills every status the viewer renders, then
 * asserts the collected payload. Run with `node test/smoke.mjs` from the
 * package root; it needs a `git` on PATH and writes only under the OS temp dir.
 */
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";

import { collectWorkingTreeDiff, hunksFromText, parseStatusEntries, parseNumstat, parseUnifiedPatch, readTextFile } from "../lib/git-diff.js";

const exec = promisify(execFile);

/** The `run` function `collectWorkingTreeDiff` drives, backed by real git. */
/** The `run` function `collectWorkingTreeDiff` drives, backed by real git. */
const runIn = (defaultCwd) => async (args, _signal, cwd) => {
  try {
    const { stdout, stderr } = await exec("git", ["-c", "core.quotepath=false", ...args], { cwd: cwd ?? defaultCwd, maxBuffer: 32 * 1024 * 1024 });
    return { exitCode: 0, stdout, stderr, lossy: false };
  } catch (error) {
    return { exitCode: error.code ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? String(error), lossy: false };
  }
};

let failures = 0;
/**
 * Run one assertion group.
 * @param label - the case name.
 * @param body - the assertions.
 */
async function check(label, body) {
  try {
    await body();
    console.log(`  ok   ${label}`);
  } catch (error) {
    failures += 1;
    console.error(`  FAIL ${label}\n       ${error.message}`);
  }
}

const root = await mkdtemp(join(tmpdir(), "dsh-diff-viewer-"));
try {
  // --- pure parsing -------------------------------------------------------
  await check("parseUnifiedPatch reads hunks, numbering, and rename status", () => {
    const patch = [
      "diff --git a/keep.txt b/keep.txt",
      "index 111..222 100644",
      "--- a/keep.txt",
      "+++ b/keep.txt",
      "@@ -1,3 +1,4 @@",
      " one",
      "-two",
      "+TWO",
      "+two and a half",
      " three",
      "diff --git a/old.txt b/new.txt",
      "similarity index 90%",
      "rename from old.txt",
      "rename to new.txt"
    ].join("\n");
    const files = parseUnifiedPatch(patch);
    const keep = files.get("keep.txt");
    assert.equal(keep.hunks.length, 1);
    assert.deepEqual(keep.hunks[0].lines.map((line) => line.kind), ["context", "delete", "add", "add", "context"]);
    assert.deepEqual(keep.hunks[0].lines[0], { kind: "context", text: "one", oldLine: 1, newLine: 1 });
    assert.deepEqual(keep.hunks[0].lines[1], { kind: "delete", text: "two", oldLine: 2 });
    assert.deepEqual(keep.hunks[0].lines[2], { kind: "add", text: "TWO", newLine: 2 });
    assert.deepEqual(keep.hunks[0].lines[3], { kind: "add", text: "two and a half", newLine: 3 });
    assert.deepEqual(keep.hunks[0].lines[4], { kind: "context", text: "three", oldLine: 3, newLine: 4 });
    assert.equal(files.get("new.txt").status, "renamed");
    assert.equal(files.get("new.txt").previousPath, "old.txt");
  });

  await check("parseUnifiedPatch flags binary and added files", () => {
    const patch = [
      "diff --git a/logo.png b/logo.png",
      "new file mode 100644",
      "index 000..abc",
      "Binary files /dev/null and b/logo.png differ"
    ].join("\n");
    const file = parseUnifiedPatch(patch).get("logo.png");
    assert.equal(file.binary, true);
    assert.equal(file.status, "added");
  });

  await check("parseUnifiedPatch unquotes a quoted path", () => {
    const patch = ['diff --git "a/a b.txt" "b/a b.txt"', "--- \"a/a b.txt\"", "+++ \"b/a b.txt\"", "@@ -1 +1 @@", "-x", "+y"].join("\n");
    assert.ok(parseUnifiedPatch(patch).has("a b.txt"));
  });

  await check("parseStatusEntries consumes a rename's origin field", () => {
    const entries = parseStatusEntries("M  staged.txt\0?? fresh.txt\0R  new.txt\0old.txt\0");
    assert.deepEqual([...entries.keys()], ["staged.txt", "fresh.txt", "new.txt"]);
    assert.deepEqual(entries.get("new.txt"), { index: "R", worktree: " " });
  });

  await check("parseNumstat reads plain, binary, and rename rows", () => {
    const stats = parseNumstat("3\t1\ta.txt\0-\t-\tbin.png\0");
    assert.deepEqual(stats.get("a.txt"), { additions: 3, deletions: 1, binary: false });
    assert.deepEqual(stats.get("bin.png"), { additions: 0, deletions: 0, binary: true });
    const renamed = parseNumstat("2\t2\t\0old.txt\0new.txt\0");
    assert.deepEqual(renamed.get("new.txt"), { additions: 2, deletions: 2, binary: false });
  });

  // --- the no-git path ----------------------------------------------------
  const plain = join(root, "not-a-repo");
  await mkdir(plain);
  await writeFile(join(plain, "readme.md"), "hello\n");
  await check("a directory without .git reports no-git", async () => {
    const result = await collectWorkingTreeDiff({ run: runIn(plain), cwd: plain, signal: undefined });
    assert.equal(result.state, "no-git");
    assert.equal(result.cwd, plain);
  });

  // --- a real repository --------------------------------------------------
  const repo = join(root, "repo");
  await mkdir(repo);
  const git = runIn(repo);
  await exec("git", ["init", "-q", "-b", "main"], { cwd: repo });
  await exec("git", ["config", "user.email", "smoke@example.test"], { cwd: repo });
  await exec("git", ["config", "user.name", "Smoke Test"], { cwd: repo });
  await writeFile(join(repo, "keep.txt"), "one\ntwo\nthree\n");
  await writeFile(join(repo, "remove.txt"), "gone\n");
  await exec("git", ["add", "-A"], { cwd: repo });
  await exec("git", ["commit", "-q", "-m", "init"], { cwd: repo });

  await check("a clean tree reports ok with no files", async () => {
    const result = await collectWorkingTreeDiff({ run: git, cwd: repo, signal: undefined });
    assert.equal(result.state, "ok");
    assert.equal(result.branch, "main");
    assert.equal(result.files.length, 0);
    assert.equal(result.counts.untracked, 0);
    assert.ok(result.head !== null);
  });

  await writeFile(join(repo, "keep.txt"), "one\nTWO\nthree\nfour\n");
  await writeFile(join(repo, "staged.txt"), "brand new\n");
  await exec("git", ["add", "staged.txt"], { cwd: repo });
  await rm(join(repo, "remove.txt"));
  await writeFile(join(repo, "fresh.txt"), "untracked\n");

  await check("a dirty tree reports every file the viewer renders", async () => {
    const result = await collectWorkingTreeDiff({ run: git, cwd: repo, signal: undefined });
    assert.equal(result.state, "ok");
    const byPath = new Map(result.files.map((file) => [file.path, file]));
    assert.deepEqual([...byPath.keys()].sort(), ["fresh.txt", "keep.txt", "remove.txt", "staged.txt"]);
    assert.equal(byPath.get("keep.txt").status, "modified");
    assert.equal(byPath.get("keep.txt").additions, 2);
    assert.equal(byPath.get("keep.txt").deletions, 1);
    assert.equal(byPath.get("keep.txt").unstaged, true);
    assert.equal(byPath.get("staged.txt").status, "added");
    assert.equal(byPath.get("remove.txt").status, "deleted");
    assert.equal(result.counts.tracked, 3);
    assert.equal(result.counts.untracked, 1);
    assert.equal(result.counts.files, 4);
    /* Untracked files carry their contents, and are grouped after the tracked ones. */
    assert.deepEqual(result.files.map((file) => file.path), ["keep.txt", "remove.txt", "staged.txt", "fresh.txt"]);
    const fresh = byPath.get("fresh.txt");
    assert.equal(fresh.status, "untracked");
    assert.equal(fresh.additions, 1);
    assert.equal(fresh.deletions, 0);
    assert.equal(fresh.note, null);
    assert.deepEqual(fresh.hunks, [
      { header: "@@ -0,0 +1,1 @@", lines: [{ kind: "add", text: "untracked", newLine: 1 }] }
    ]);
    /* Untracked additions join the running total. */
    assert.equal(result.counts.additions, 4);
    assert.equal(result.counts.deletions, 2);
    assert.ok(byPath.get("keep.txt").hunks.length > 0);
    assert.equal(result.root, await realpath(repo));
  });

  /* --- untracked contents ------------------------------------------------- */
  const loose = join(root, "untracked");
  await mkdir(loose);
  const looseGit = runIn(loose);
  await exec("git", ["init", "-q", "-b", "main"], { cwd: loose });
  await writeFile(join(loose, "plain.txt"), "alpha\nbeta\n");
  await writeFile(join(loose, "no-newline.txt"), "tail");
  await writeFile(join(loose, "crlf.txt"), "one\r\ntwo\r\n");
  await writeFile(join(loose, "empty.txt"), "");
  await writeFile(join(loose, "blob.bin"), Buffer.from([0x89, 0x50, 0x00, 0x47, 0x0d]));
  await writeFile(join(loose, "big.txt"), "x".repeat(600 * 1024));

  await check("hunksFromText presents a file as one all-additions hunk", () => {
    assert.deepEqual(hunksFromText(""), []);
    assert.deepEqual(hunksFromText("a\n"), [
      { header: "@@ -0,0 +1,1 @@", lines: [{ kind: "add", text: "a", newLine: 1 }] }
    ]);
    /* A missing final newline is git's own annotation, and empty lines survive. */
    assert.deepEqual(hunksFromText("a\n\nb"), [
      {
        header: "@@ -0,0 +1,3 @@",
        lines: [
          { kind: "add", text: "a", newLine: 1 },
          { kind: "add", text: "", newLine: 2 },
          { kind: "add", text: "b", newLine: 3 },
          { kind: "meta", text: "No newline at end of file" }
        ]
      }
    ]);
    /* CRLF is normalised for display so no stray caret shows. */
    assert.deepEqual(hunksFromText("a\r\nb\r\n")[0].lines, [
      { kind: "add", text: "a", newLine: 1 },
      { kind: "add", text: "b", newLine: 2 }
    ]);
  });

  await check("untracked files carry their contents, not just their paths", async () => {
    const result = await collectWorkingTreeDiff({ run: looseGit, cwd: loose, signal: undefined });
    const byPath = new Map(result.files.map((file) => [file.path, file]));
    assert.deepEqual([...byPath.keys()], ["big.txt", "blob.bin", "crlf.txt", "empty.txt", "no-newline.txt", "plain.txt"]);
    assert.equal(result.counts.tracked, 0);
    assert.equal(result.counts.untracked, 6);

    const plain = byPath.get("plain.txt");
    assert.equal(plain.status, "untracked");
    assert.equal(plain.additions, 2);
    assert.equal(plain.note, null);
    assert.deepEqual(plain.hunks[0].lines, [
      { kind: "add", text: "alpha", newLine: 1 },
      { kind: "add", text: "beta", newLine: 2 }
    ]);

    const unterminated = byPath.get("no-newline.txt");
    assert.equal(unterminated.additions, 1);
    assert.equal(unterminated.hunks[0].lines[1].kind, "meta");

    const crlf = byPath.get("crlf.txt");
    assert.deepEqual(crlf.hunks[0].lines.map((line) => line.text), ["one", "two"]);

    /* An empty file is neither binary nor an error: it says it is empty. */
    const empty = byPath.get("empty.txt");
    assert.deepEqual(empty.hunks, []);
    assert.equal(empty.additions, 0);
    assert.equal(empty.note, "empty-file");

    const blob = byPath.get("blob.bin");
    assert.equal(blob.binary, true);
    assert.equal(blob.note, "binary");
    assert.deepEqual(blob.hunks, []);

    const big = byPath.get("big.txt");
    assert.equal(big.note, "large");
    assert.deepEqual(big.hunks, []);

    assert.equal(result.counts.additions, 5);
  });

  await check("an unreadable untracked file is reported, never dropped", async () => {
    const readFile = async (absolutePath, maxBytes) =>
      absolutePath.endsWith("plain.txt") ? { kind: "unreadable" } : readTextFile(absolutePath, maxBytes);
    const result = await collectWorkingTreeDiff({ run: looseGit, cwd: loose, signal: undefined, readFile });
    const plain = result.files.find((file) => file.path === "plain.txt");
    assert.equal(plain.note, "unreadable");
    assert.deepEqual(plain.hunks, []);
    assert.equal(result.files.length, 6);
  });

  await check("the untracked byte budget stops reading and says so", async () => {
    /* Report every file as 3 MiB so the 4 MiB budget is spent after two reads. */
    const readFile = async () => ({ kind: "text", text: "x\n", bytes: 3 * 1024 * 1024, truncated: false });
    const result = await collectWorkingTreeDiff({ run: looseGit, cwd: loose, signal: undefined, readFile });
    assert.deepEqual(result.files.map((file) => file.note), [null, null, "omitted", "omitted", "omitted", "omitted"]);
    /* The skipped files still appear, so the list is never silently short. */
    assert.equal(result.files.length, 6);
    assert.equal(result.counts.untracked, 6);
  });

  await check("an unborn repository still reports its staged files", async () => {
    const unborn = join(root, "unborn");
    await mkdir(unborn);
    const unbornGit = runIn(unborn);
    await exec("git", ["init", "-q", "-b", "main"], { cwd: unborn });
    await writeFile(join(unborn, "first.txt"), "hello\n");
    await exec("git", ["add", "-A"], { cwd: unborn });
    const result = await collectWorkingTreeDiff({ run: unbornGit, cwd: unborn, signal: undefined });
    assert.equal(result.state, "ok");
    assert.equal(result.unborn, true);
    assert.equal(result.head, null);
    assert.equal(result.branch, "main");
    assert.deepEqual(result.files.map((file) => file.path), ["first.txt"]);
    assert.equal(result.files[0].status, "added");
  });

  await check("a subdirectory with no .git of its own reports no-git", async () => {
    const nested = join(repo, "packages", "inner");
    await mkdir(nested, { recursive: true });
    await writeFile(join(nested, "inner.txt"), "nested\n");
    const result = await collectWorkingTreeDiff({ run: runIn(nested), cwd: nested, signal: undefined });
    /* The spec is the literal `.git` entry, so an enclosing repository is not
       claimed — and no git process runs at all. */
    assert.equal(result.state, "no-git");
    assert.equal(result.cwd, nested);
  });

  await check("a missing git executable surfaces an error, not a crash", async () => {
    const broken = async () => ({ exitCode: 127, stdout: "", stderr: "git: command not found", lossy: false });
    await assert.rejects(() => collectWorkingTreeDiff({ run: broken, cwd: repo, signal: undefined }), /git status --porcelain=v1/);
  });
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nall checks passed" : `\n${String(failures)} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
