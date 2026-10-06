/**
 * End-to-end test for the host half's HTTP route.
 *
 * Loads `lib/index.js` with a stub Cordis context whose `subprocess` runs real
 * git, then drives the registered handler with fake request/response objects.
 * This covers the wiring the pure collector test cannot: the route path, method
 * and authorization handling, working-directory resolution, and the JSON body.
 *
 * Run with `node test/host-route.mjs` from the package root.
 */
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

import { apply, inject, name } from "../lib/index.js";

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

/**
 * A `SubprocessHandle` backed by a real child process.
 * @param spec - the spawn spec `lib/index.js` builds.
 * @returns the handle the collector reads.
 */
function spawnReal(spec) {
  const [program, ...args] = spec.argv;
  const child = spawn(program, args, { cwd: spec.cwd, env: { ...process.env, ...spec.env } });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const done = new Promise((resolve) => {
    child.on("error", (error) => {
      stderr += error.message;
      resolve({ exitCode: null, signal: null });
    });
    child.on("close", (exitCode, signal) => {
      resolve({ exitCode, signal });
    });
  });
  /* Readers must observe the buffers at read time, like the real service: the
     collect-mode reader is called after `done` resolves, not when the handle is
     built. Capturing the string by value here would always read "". */
  const reader = (current) => ({ readFrom: () => ({ text: current(), nextOffset: Buffer.byteLength(current()), lossy: false }) });
  return {
    collected: { stdout: reader(() => stdout), stderr: reader(() => stderr) },
    done,
    terminate: () => child.kill(),
    waitForExit: async () => true,
  };
}

/**
 * Build the plugin's context stub and capture its route.
 * @param options - the session cwd lookup and the rejection the fence reports.
 * @returns the captured route plus the recorded spawn spec.
 */
function mountPlugin(options = {}) {
  const state = { route: undefined, spawns: [], effects: 0 };
  const ctx = {
    effect(fn, label) {
      state.effects += 1;
      void label;
      const dispose = fn();
      return typeof dispose === "function" ? dispose : () => {};
    },
    get: (key) => (key === "sandboxPolicy" ? options.sandboxPolicy : options.sessionPersistence),
    sessions: { get: (id) => (options.sessionCwd === undefined ? undefined : { header: { id, cwd: options.sessionCwd } }) },
    connection: { requestRejection: () => options.rejection },
    webServer: { register: (route) => ((state.route = route), () => {}) },
    subprocess: {
      resolveExecutable: async (command) => command,
      spawn: (spec) => {
        state.spawns.push(spec);
        return spawnReal(spec);
      },
    },
  };
  apply(ctx);
  return state;
}

/**
 * A fake Node response that records everything the handler writes.
 * @returns the response plus a promise for its completion.
 */
function fakeResponse() {
  const chunks = [];
  let settle;
  const finished = new Promise((resolve) => {
    settle = resolve;
  });
  const headers = new Map();
  return {
    statusCode: undefined,
    headers,
    writableEnded: false,
    on() {},
    off() {},
    setHeader(key, value) {
      headers.set(key, value);
    },
    write(chunk) {
      chunks.push(String(chunk));
    },
    end(chunk) {
      if (chunk !== undefined) chunks.push(String(chunk));
      this.writableEnded = true;
      settle();
    },
    finished,
    json() {
      const raw = chunks.join("");
      return raw === "" ? null : JSON.parse(raw);
    },
  };
}

/**
 * Drive the captured route once.
 * @param state - the mounted plugin state.
 * @param request - method, url, and any headers.
 * @returns the status code and parsed body.
 */
async function call(state, request) {
  assert.ok(state.route !== undefined, "the plugin registered no route");
  const res = fakeResponse();
  await state.route.handler({ method: request.method ?? "GET", url: request.url, headers: request.headers ?? {} }, res);
  await res.finished;
  return { status: res.statusCode, body: res.json() };
}

const root = await mkdtemp(join(tmpdir(), "dsh-diff-viewer-route-"));
try {
  const repo = join(root, "repo");
  await mkdir(repo);
  const git = (...args) => new Promise((resolve) => spawn("git", args, { cwd: repo }).on("close", resolve));
  await git("init", "-q", "-b", "main");
  await git("config", "user.email", "route@example.test");
  await git("config", "user.name", "Route Test");
  await writeFile(join(repo, "tracked.txt"), "before\n");
  await git("add", "-A");
  await git("commit", "-q", "-m", "init");
  await writeFile(join(repo, "tracked.txt"), "after\n");

  await check("the plugin exports the expected Cordis shape", () => {
    assert.equal(name, "dsh-diff-viewer");
    assert.ok(Array.isArray(inject));
    assert.ok(inject.includes("webServer"));
    assert.ok(inject.includes("connection"));
    assert.ok(inject.includes("sessions"));
    assert.ok(inject.includes("subprocess"));
  });

  await check("the route is registered as an exact GET path", () => {
    const state = mountPlugin();
    assert.equal(state.route.kind, "exact");
    assert.equal(state.route.path, "/dsh-diff-viewer/diff");
    assert.equal(typeof state.route.handler, "function");
    assert.equal(state.effects, 1);
  });

  await check("an authorized request returns the diff for the session cwd", async () => {
    const state = mountPlugin({ sessionCwd: repo });
    const { status, body } = await call(state, { url: "/dsh-diff-viewer/diff?sessionId=session-1" });
    assert.equal(status, 200);
    assert.equal(body.state, "ok");
    assert.equal(body.cwd, repo);
    assert.equal(body.branch, "main");
    assert.deepEqual(body.files.map((file) => file.path), ["tracked.txt"]);
    assert.equal(body.files[0].additions, 1);
    assert.equal(body.files[0].deletions, 1);
    assert.equal(typeof body.generatedAt, "string");
    /* Every spawn carried the git hardening and an absolute cwd. */
    assert.ok(state.spawns.length > 0);
    for (const spec of state.spawns) {
      assert.equal(spec.env.GIT_TERMINAL_PROMPT, "0");
      assert.equal(spec.env.GIT_OPTIONAL_LOCKS, "0");
      assert.equal(spec.argv[0], "git");
      assert.equal(spec.argv[1], "-c");
      assert.ok(spec.cwd.startsWith("/"));
    }
  });

  await check("an explicit ?path= wins over the session header", async () => {
    const other = join(root, "other");
    await mkdir(other);
    await writeFile(join(other, "plain.txt"), "hello\n");
    const state = mountPlugin({ sessionCwd: repo });
    const { status, body } = await call(state, { url: `/dsh-diff-viewer/diff?path=${encodeURIComponent(other)}` });
    assert.equal(status, 200);
    assert.equal(body.state, "no-git");
    assert.equal(body.cwd, other);
    assert.match(body.message, /no \.git directory/);
  });

  await check("a directory without .git reports the non-git project state", async () => {
    const plain = join(root, "plain-project");
    await mkdir(plain);
    const state = mountPlugin({ sessionCwd: plain });
    const { status, body } = await call(state, { url: "/dsh-diff-viewer/diff?sessionId=session-zone" });
    assert.equal(status, 200);
    assert.equal(body.state, "no-git");
    assert.equal(body.cwd, plain);
    /* No `.git` means no git process at all — the decision is a filesystem fact. */
    assert.equal(state.spawns.length, 0);
  });

  await check("no known directory is a 404, not an empty diff", async () => {
    const state = mountPlugin();
    const { status, body } = await call(state, { url: "/dsh-diff-viewer/diff" });
    assert.equal(status, 404);
    assert.equal(body.state, "error");
  });

  await check("the sandbox policy root is the last-resort working directory", async () => {
    const state = mountPlugin({ sandboxPolicy: { workspaceRoot: repo } });
    const { status, body } = await call(state, { url: "/dsh-diff-viewer/diff?sessionId=gone" });
    assert.equal(status, 200);
    assert.equal(body.cwd, repo);
    assert.equal(body.state, "ok");
  });

  await check("the authenticated fence refuses before any git runs", async () => {
    const state = mountPlugin({ sessionCwd: repo, rejection: 401 });
    const { status } = await call(state, { url: "/dsh-diff-viewer/diff?sessionId=session-1" });
    assert.equal(status, 401);
    assert.equal(state.spawns.length, 0);
  });

  await check("any method other than GET is a 405", async () => {
    const state = mountPlugin({ sessionCwd: repo });
    const { status } = await call(state, { method: "POST", url: "/dsh-diff-viewer/diff?sessionId=session-1" });
    assert.equal(status, 405);
    assert.equal(state.spawns.length, 0);
  });
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nall checks passed" : `\n${String(failures)} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
