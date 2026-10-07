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
 * Build the plugin's context stub and capture its routes.
 * @param options - the session cwd lookup, the rejection the fence reports, and
 *   the filesystem stub the event stream arms watches through.
 * @returns the captured routes plus the recorded spawns and watches.
 */
function mountPlugin(options = {}) {
  const state = { routes: new Map(), spawns: [], watchers: new Map(), effects: 0, disposed: 0 };
  state.fs = fakeFs(state);
  const ctx = {
    effect(fn, label) {
      state.effects += 1;
      void label;
      const dispose = fn();
      state.dispose = typeof dispose === "function" ? dispose : () => {};
      return state.dispose;
    },
    get: (key) => {
      if (key === "sandboxPolicy") return options.sandboxPolicy;
      if (key === "sessionPersistence") return options.sessionPersistence;
      if (key === "fs") return options.fs === undefined ? state.fs : options.fs;
      return undefined;
    },
    sessions: { get: (id) => (options.sessionCwd === undefined ? undefined : { header: { id, cwd: options.sessionCwd } }) },
    connection: { requestRejection: () => options.rejection },
    webServer: {
      register: (route) => {
        state.routes.set(route.path, route);
        return () => {
          state.disposed += 1;
          state.routes.delete(route.path);
        };
      },
    },
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
 * The filesystem stub the event stream resolves and watches directories with.
 * @param state - the mounted plugin state, which records the watches.
 * @returns the stub `ctx.fs`.
 */
function fakeFs(state) {
  return {
    resolve: async (path) => ({ targetKey: path, displayPath: path }),
    watch: async (target, changed) => {
      state.watchers.set(target.displayPath, changed);
      return async () => {
        state.watchers.delete(target.displayPath);
      };
    },
  };
}

/**
 * A fake Node response that records everything the handler writes.
 *
 * It is a small emitter rather than a stub with no-op listeners, because the
 * event stream's teardown hangs off `close` and `error` and has to be drivable.
 *
 * @returns the response plus a promise for its completion.
 */
function fakeResponse() {
  const chunks = [];
  const listeners = new Map();
  let settle;
  const finished = new Promise((resolve) => {
    settle = resolve;
  });
  const headers = new Map();
  const res = {
    statusCode: undefined,
    headers,
    writableEnded: false,
    destroyed: false,
    on(event, handler) {
      const list = listeners.get(event) ?? [];
      list.push(handler);
      listeners.set(event, list);
      return res;
    },
    off(event, handler) {
      const list = listeners.get(event) ?? [];
      const index = list.indexOf(handler);
      if (index >= 0) list.splice(index, 1);
      return res;
    },
    emit(event) {
      for (const handler of [...(listeners.get(event) ?? [])]) handler();
    },
    writeHead(status, extra) {
      res.statusCode = status;
      for (const [key, value] of Object.entries(extra ?? {})) headers.set(key, value);
      return res;
    },
    setHeader(key, value) {
      headers.set(key, value);
    },
    write(chunk) {
      chunks.push(String(chunk));
      return true;
    },
    end(chunk) {
      if (chunk !== undefined) chunks.push(String(chunk));
      res.writableEnded = true;
      settle();
    },
    finished,
    text() {
      return chunks.join("");
    },
    json() {
      const raw = res.text();
      return raw === "" ? null : JSON.parse(raw);
    },
  };
  return res;
}

/**
 * Drive the captured diff route once.
 * @param state - the mounted plugin state.
 * @param request - method, url, and any headers.
 * @returns the status code and parsed body.
 */
async function call(state, request) {
  const route = state.routes.get(request.path ?? "/dsh-diff-view/diff");
  assert.ok(route !== undefined, `the plugin registered no route for ${request.path ?? "/dsh-diff-view/diff"}`);
  const res = fakeResponse();
  await route.handler({ method: request.method ?? "GET", url: request.url, headers: request.headers ?? {} }, res);
  await res.finished;
  return { status: res.statusCode, body: res.json() };
}

/**
 * Wait until a condition holds.
 * @param predicate - `() => boolean`.
 * @param label - what is being waited for.
 */
async function until(predicate, label) {
  for (let turn = 0; turn < 200; turn += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** One turn of the event loop, so scheduled work can run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Every diff payload an event stream has pushed so far.
 * @param res - the fake response the stream writes into.
 * @returns the parsed payloads, in order.
 */
function diffFrames(res) {
  const prefix = "event: diff\ndata: ";
  return res
    .text()
    .split("\n\n")
    .filter((block) => block.startsWith(prefix))
    .map((block) => JSON.parse(block.slice(prefix.length)));
}

const root = await mkdtemp(join(tmpdir(), "dsh-diff-view-route-"));
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
    assert.equal(name, "dsh-diff-view");
    assert.ok(Array.isArray(inject));
    assert.ok(inject.includes("webServer"));
    assert.ok(inject.includes("connection"));
    assert.ok(inject.includes("sessions"));
    assert.ok(inject.includes("subprocess"));
  });

  await check("the routes are registered as exact paths, over one effect", () => {
    const state = mountPlugin();
    assert.deepEqual([...state.routes.keys()].sort(), ["/dsh-diff-view/diff", "/dsh-diff-view/events"]);
    for (const route of state.routes.values()) {
      assert.equal(route.kind, "exact");
      assert.equal(typeof route.handler, "function");
    }
    assert.equal(state.effects, 1);
  });

  await check("an authorized request returns the diff for the session cwd", async () => {
    const state = mountPlugin({ sessionCwd: repo });
    const { status, body } = await call(state, { url: "/dsh-diff-view/diff?sessionId=session-1" });
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
    const { status, body } = await call(state, { url: `/dsh-diff-view/diff?path=${encodeURIComponent(other)}` });
    assert.equal(status, 200);
    assert.equal(body.state, "no-git");
    assert.equal(body.cwd, other);
    assert.match(body.message, /no \.git directory/);
  });

  await check("a directory without .git reports the non-git project state", async () => {
    const plain = join(root, "plain-project");
    await mkdir(plain);
    const state = mountPlugin({ sessionCwd: plain });
    const { status, body } = await call(state, { url: "/dsh-diff-view/diff?sessionId=session-zone" });
    assert.equal(status, 200);
    assert.equal(body.state, "no-git");
    assert.equal(body.cwd, plain);
    /* No `.git` means no git process at all — the decision is a filesystem fact. */
    assert.equal(state.spawns.length, 0);
  });

  await check("no known directory is a 404, not an empty diff", async () => {
    const state = mountPlugin();
    const { status, body } = await call(state, { url: "/dsh-diff-view/diff" });
    assert.equal(status, 404);
    assert.equal(body.state, "error");
  });

  await check("the sandbox policy root is the last-resort working directory", async () => {
    const state = mountPlugin({ sandboxPolicy: { workspaceRoot: repo } });
    const { status, body } = await call(state, { url: "/dsh-diff-view/diff?sessionId=gone" });
    assert.equal(status, 200);
    assert.equal(body.cwd, repo);
    assert.equal(body.state, "ok");
  });

  await check("the authenticated fence refuses before any git runs", async () => {
    const state = mountPlugin({ sessionCwd: repo, rejection: 401 });
    const { status } = await call(state, { url: "/dsh-diff-view/diff?sessionId=session-1" });
    assert.equal(status, 401);
    assert.equal(state.spawns.length, 0);
  });

  await check("any method other than GET is a 405", async () => {
    const state = mountPlugin({ sessionCwd: repo });
    const { status } = await call(state, { method: "POST", url: "/dsh-diff-view/diff?sessionId=session-1" });
    assert.equal(status, 405);
    assert.equal(state.spawns.length, 0);
  });

  /* --- the event stream --------------------------------------------------- */
  await check("the stream answers with an event stream, not a body", async () => {
    const state = mountPlugin({ sessionCwd: repo });
    const res = fakeResponse();
    await state.routes
      .get("/dsh-diff-view/events")
      .handler({ method: "GET", url: "/dsh-diff-view/events?sessionId=session-1", headers: {} }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers.get("content-type"), "text/event-stream");
    await until(() => res.text().includes("event: diff"), "the first pushed frame");
    assert.match(res.text(), /^: connected\n\n/);
    const [payload] = diffFrames(res);
    assert.equal(payload.state, "ok");
    assert.equal(payload.cwd, repo);
    assert.equal(typeof payload.generatedAt, "string");
    assert.ok(state.watchers.size > 0, "the stream armed no directory watch");
    res.emit("close");
    await until(() => state.watchers.size === 0, "the watches to close");
  });

  await check("the stream pushes again when the working tree changes", async () => {
    const state = mountPlugin({ sessionCwd: repo });
    const res = fakeResponse();
    await state.routes
      .get("/dsh-diff-view/events")
      .handler({ method: "GET", url: "/dsh-diff-view/events?sessionId=session-1", headers: {} }, res);
    await until(() => diffFrames(res).length === 1, "the first pushed frame");
    assert.ok(!diffFrames(res)[0].files.some((file) => file.path === "streamed.txt"), "the fixture started dirty");

    await writeFile(join(repo, "streamed.txt"), "pushed\n");
    /* The watch is what the Host's filesystem service would have fired. */
    for (const changed of [...state.watchers.values()]) changed();
    await until(() => diffFrames(res).length === 2, "the pushed change");
    const pushed = diffFrames(res)[1];
    assert.ok(pushed.files.some((file) => file.path === "streamed.txt"), "the new file was not pushed");
    res.emit("close");
    await until(() => state.watchers.size === 0, "the watches to close");
    await rm(join(repo, "streamed.txt"));
  });

  await check("the stream is fenced, method-checked, and needs a directory", async () => {
    const fenced = mountPlugin({ sessionCwd: repo, rejection: 403 });
    const refused = fakeResponse();
    await fenced.routes
      .get("/dsh-diff-view/events")
      .handler({ method: "GET", url: "/dsh-diff-view/events?sessionId=session-1", headers: {} }, refused);
    assert.equal(refused.statusCode, 403);
    assert.equal(fenced.spawns.length, 0, "the fence let a git process run");

    const posted = mountPlugin({ sessionCwd: repo });
    const wrongMethod = fakeResponse();
    await posted.routes
      .get("/dsh-diff-view/events")
      .handler({ method: "POST", url: "/dsh-diff-view/events?sessionId=session-1", headers: {} }, wrongMethod);
    assert.equal(wrongMethod.statusCode, 405);
    assert.equal(posted.spawns.length, 0);

    const homeless = mountPlugin();
    const lost = fakeResponse();
    await homeless.routes
      .get("/dsh-diff-view/events")
      .handler({ method: "GET", url: "/dsh-diff-view/events", headers: {} }, lost);
    await lost.finished;
    assert.equal(lost.statusCode, 404);
    assert.equal(lost.json().state, "error");
  });

  await check("unloading the plugin ends its streams and stops its watches", async () => {
    const state = mountPlugin({ sessionCwd: repo });
    const res = fakeResponse();
    await state.routes
      .get("/dsh-diff-view/events")
      .handler({ method: "GET", url: "/dsh-diff-view/events?sessionId=session-1", headers: {} }, res);
    await until(() => diffFrames(res).length === 1, "the first pushed frame");
    assert.ok(state.watchers.size > 0, "the stream armed no directory watch");

    /* `ctx.effect` hands back the disposer the Loader calls when the plugin unloads. */
    state.dispose();
    assert.equal(state.disposed, 2, "both routes were not disposed");
    assert.equal(res.writableEnded, true, "the open stream outlived the plugin");
    await until(() => state.watchers.size === 0, "the watches to close");
  });
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nall checks passed" : `\n${String(failures)} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
