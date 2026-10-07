/**
 * Tests for the host half's change detector.
 *
 * `lib/diff-watch.js` is transport-free by construction, so everything here
 * runs against fakes: a probe whose fingerprint the test moves by hand, a
 * collector that counts its calls, and directory watches the test fires. That
 * is the only way to assert the property the module exists for — *how much work
 * a quiet working tree costs* — without a Host, a repository, or a stopwatch.
 *
 * Run with `node test/watch.mjs` from the package root.
 */
import assert from "node:assert/strict";

import { DiffWatch, payloadKey, watchedDirectories } from "../lib/diff-watch.js";

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
 * Wait until a condition holds.
 * @param predicate - `() => boolean`.
 * @param label - what is being waited for, for the failure message.
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
 * Build a detector over fakes, with the state a test steers.
 *
 * @param options - the interval settings and the initial tree state.
 * @returns the detector, its counters, and the handles a test drives.
 */
function harness(options = {}) {
  const state = {
    /** What the cheap probe reports; the test moves it to say "the tree moved". */
    fingerprint: "f1",
    /** What a collection returns. */
    payload: { state: "ok", root: "/repo", files: [{ path: "a.txt", previousPath: null }], generatedAt: "t1" },
    /** Everything pushed to a viewer. */
    pushed: [],
    /** How many probes and collections ran. */
    probes: 0,
    collections: 0,
    /** How many collections to fail before one succeeds. */
    failCollect: 0,
    /** Watch arming failures the detector reported. */
    errors: [],
    /** Watches the detector holds, by path. */
    watches: new Map(),
  };
  const watch = new DiffWatch({
    cwd: "/repo",
    probe: async () => {
      state.probes += 1;
      return state.fingerprint;
    },
    collect: async () => {
      state.collections += 1;
      if (state.failCollect > 0) {
        state.failCollect -= 1;
        throw new Error("git failed");
      }
      return state.payload;
    },
    watch: async (path, changed) => {
      if (options.failWatch === true) throw new Error(`cannot watch ${path}`);
      const record = { changed, closed: false };
      state.watches.set(path, record);
      return async () => {
        record.closed = true;
        state.watches.delete(path);
      };
    },
    onError: (error) => state.errors.push(error),
    debounceMs: options.debounceMs ?? 5,
    /* Zero by default: every other case here is about the schedule, not the rate. */
    minCheckMs: options.minCheckMs ?? 0,
    idleMs: options.idleMs ?? 20,
    idleMaxMs: options.idleMaxMs ?? 40,
    maxDirectories: options.maxDirectories ?? 24,
  });
  return {
    state,
    watch,
    /** Fire one filesystem event on a watched directory. */
    fire(path) {
      const record = state.watches.get(path);
      assert.ok(record !== undefined, `no watch on ${path}`);
      record.changed();
    },
  };
}

console.log("change detection");

await check("watchedDirectories pins the tree's own directories, then the diff's", () => {
  const payload = {
    state: "ok",
    root: "/repo",
    files: [
      { path: "a.txt", previousPath: null },
      { path: "src/b.js", previousPath: "lib/old.js" }
    ]
  };
  assert.deepEqual(watchedDirectories(payload, "/repo"), ["/repo", "/repo/.git", "/repo/lib", "/repo/src"]);
  /* The session directory is pinned even when it sits under the root. */
  assert.deepEqual(watchedDirectories(payload, "/repo/pkg"), ["/repo/pkg", "/repo", "/repo/.git", "/repo/lib", "/repo/src"]);
  /* The cap never drops a pinned directory for a file's. */
  assert.deepEqual(watchedDirectories(payload, "/repo", 3), ["/repo", "/repo/.git", "/repo/lib"]);
  /* A file at the root adds no directory of its own. */
  assert.deepEqual(watchedDirectories({ state: "ok", root: "/repo", files: [{ path: "a.txt" }] }, "/repo"), ["/repo", "/repo/.git"]);
  /* Without a repository there is nothing but the session directory to watch. */
  assert.deepEqual(watchedDirectories({ state: "no-git" }, "/gone"), ["/gone"]);
});

await check("payloadKey ignores when the payload was produced", () => {
  const payload = { state: "ok", files: [], generatedAt: "2020-01-01T00:00:00.000Z" };
  assert.equal(payloadKey(payload), payloadKey({ ...payload, generatedAt: "2026-01-01T00:00:00.000Z" }));
  assert.notEqual(payloadKey(payload), payloadKey({ ...payload, branch: "main" }));
});

await check("a working tree nobody is watching costs nothing at all", async () => {
  const { state, watch } = harness();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(state.probes, 0, "a probe ran with no viewer");
  assert.equal(state.collections, 0, "a collection ran with no viewer");
  assert.equal(watch.directories.length, 0, "a watch was armed with no viewer");
});

await check("the first viewer gets the current diff, and the watches the payload needs", async () => {
  const { state, watch } = harness();
  const stop = watch.subscribe((payload) => state.pushed.push(payload));
  await until(() => state.pushed.length === 1, "the first payload");
  assert.equal(state.probes, 1, "the first check did not probe");
  assert.equal(state.collections, 1, "the first check did not collect");
  assert.equal(state.pushed[0].files[0].path, "a.txt");
  assert.deepEqual(watch.directories.sort(), ["/repo", "/repo/.git"]);
  stop();
});

await check("an idle tree is probed, never collected", async () => {
  const { state, watch } = harness({ idleMs: 20 });
  const stop = watch.subscribe(() => {});
  await until(() => state.probes >= 3, "idle probes");
  assert.equal(state.collections, 1, "an idle tree was collected again");
  /* The idle gap doubles while the tree stays still, so the probing slows. */
  stop();
});

await check("a moved fingerprint collects exactly once and pushes", async () => {
  const { state, watch } = harness({ idleMs: 20 });
  const stop = watch.subscribe((payload) => state.pushed.push(payload));
  await until(() => state.pushed.length === 1, "the first payload");
  state.fingerprint = "f2";
  state.payload = { ...state.payload, files: [{ path: "b.txt", previousPath: null }], generatedAt: "t2" };
  await until(() => state.pushed.length === 2, "the pushed change");
  assert.equal(state.collections, 2, "the change was collected more than once");
  assert.equal(state.pushed[1].files[0].path, "b.txt");
  stop();
});

await check("a watched directory shortens the wait, and a quiet event costs only a probe", async () => {
  /* The idle gap is long here on purpose: anything that arrives quickly came
     from the event, not from the timer. */
  const { state, watch, fire } = harness({ idleMs: 5_000, debounceMs: 5 });
  const stop = watch.subscribe((payload) => state.pushed.push(payload));
  await until(() => state.pushed.length === 1, "the first payload");
  const probesBefore = state.probes;

  /* An event on a directory the diff touches, with the tree untouched: one
     probe, and no diff generated for a change the panel would not draw. */
  fire("/repo");
  await until(() => state.probes > probesBefore, "the probe after the event");
  assert.equal(state.collections, 1, "an event that changed nothing ran a collection");

  state.fingerprint = "f2";
  state.payload = { ...state.payload, files: [{ path: "b.txt", previousPath: null }], generatedAt: "t2" };
  fire("/repo");
  await until(() => state.pushed.length === 2, "the pushed change");
  assert.equal(state.collections, 2, "the changed tree was collected more than once");
  stop();
});

await check("a payload the panel already draws is never pushed", async () => {
  const { state, watch } = harness({ idleMs: 20 });
  const stop = watch.subscribe((payload) => state.pushed.push(payload));
  await until(() => state.pushed.length === 1, "the first payload");
  /* The tree moved — the timestamp proves a collection ran — but the diff is
     the one already on screen. */
  state.fingerprint = "f2";
  state.payload = { ...state.payload, generatedAt: "t2" };
  await until(() => state.collections === 2, "the second collection");
  await settle();
  assert.equal(state.pushed.length, 1, "an identical payload was pushed");
  stop();
});

await check("the watched set follows the payload, closing what it leaves", async () => {
  const { state, watch } = harness({ idleMs: 20 });
  const stop = watch.subscribe((payload) => state.pushed.push(payload));
  await until(() => state.pushed.length === 1, "the first payload");
  state.fingerprint = "f2";
  state.payload = {
    state: "ok",
    root: "/repo",
    files: [{ path: "src/deep/b.js", previousPath: null }],
    generatedAt: "t2"
  };
  await until(() => watch.directories.includes("/repo/src/deep"), "the new directory to be watched");
  assert.equal(state.watches.get("/repo")?.closed, false, "the root watch was closed");
  stop();
  assert.equal(state.watches.size, 0, "a watch outlived the viewer");
});

await check("a watch cap keeps the detector bounded", async () => {
  const { state, watch } = harness({ idleMs: 20, maxDirectories: 3 });
  const stop = watch.subscribe((payload) => state.pushed.push(payload));
  await until(() => state.pushed.length === 1, "the first payload");
  state.fingerprint = "f2";
  state.payload = {
    state: "ok",
    root: "/repo",
    files: [
      { path: "one/a.txt", previousPath: null },
      { path: "two/b.txt", previousPath: null },
      { path: "three/c.txt", previousPath: null }
    ],
    generatedAt: "t2"
  };
  await until(() => state.collections === 2, "the second collection");
  await settle();
  assert.equal(watch.directories.length, 3, `watches are not capped: ${watch.directories.join(", ")}`);
  assert.deepEqual(watch.directories.sort(), ["/repo", "/repo/.git", "/repo/one"]);
  stop();
});

await check("an unwatchable directory is reported, and the probe still refreshes", async () => {
  const { state, watch } = harness({ idleMs: 20, failWatch: true });
  const stop = watch.subscribe((payload) => state.pushed.push(payload));
  await until(() => state.pushed.length === 1, "the first payload");
  assert.ok(state.errors.length > 0, "the failed watch was swallowed");
  assert.equal(watch.directories.length, 0);
  state.fingerprint = "f2";
  state.payload = { ...state.payload, files: [{ path: "b.txt", previousPath: null }], generatedAt: "t2" };
  await until(() => state.pushed.length === 2, "the pushed change");
  stop();
});

await check("a directory that never stops churning is held to one check a second", async () => {
  /* Debouncing folds a burst; it does not bound a stream. Without the floor a
     watched directory being written ten times a second would buy a probe every
     debounce window, for as long as the writing lasts. */
  const { state, watch, fire } = harness({ debounceMs: 5, minCheckMs: 60, idleMs: 5_000 });
  const stop = watch.subscribe(() => {});
  await until(() => state.probes >= 1, "the first check");
  const first = state.probes;
  const started = Date.now();
  const storm = setInterval(() => fire("/repo"), 2);
  await new Promise((resolve) => setTimeout(resolve, 220));
  clearInterval(storm);
  const elapsed = Date.now() - started;
  const checks = state.probes - first;
  assert.ok(checks <= Math.ceil(elapsed / 60) + 1, `${String(checks)} checks in ${String(elapsed)}ms is not throttled`);
  /* And the throttle is not a mute: the storm still produced checks. */
  assert.ok(checks >= 2, `the storm produced only ${String(checks)} checks`);
  stop();
});

await check("a collection that fails is retried, not filed as delivered", async () => {
  const { state, watch } = harness({ idleMs: 15 });
  state.failCollect = 1;
  const stop = watch.subscribe((payload) => state.pushed.push(payload));
  await until(() => state.pushed.length === 1, "the retried payload");
  assert.equal(state.collections, 2, "the failed collection was not retried");
  assert.ok(state.errors.length > 0, "the failure was swallowed");
  stop();
});

await check("the last viewer takes the timers and the watches with it", async () => {
  const { state, watch } = harness({ idleMs: 20 });
  const stop = watch.subscribe(() => {});
  await until(() => state.probes >= 1, "the first check");
  stop();
  await settle();
  assert.equal(watch.viewers, 0);
  assert.equal(state.watches.size, 0, "a watch outlived the last viewer");
  const probes = state.probes;
  const collections = state.collections;
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(state.probes, probes, "the probe kept running with no viewer");
  assert.equal(state.collections, collections, "the collector kept running with no viewer");
});

await check("a viewer that comes back starts a fresh detector", async () => {
  const { state, watch } = harness();
  const first = watch.subscribe(() => {});
  await until(() => state.collections === 1, "the first collection");
  first();
  await settle();
  state.pushed = [];
  const stop = watch.subscribe((payload) => state.pushed.push(payload));
  await until(() => state.pushed.length === 1, "the payload after resubscribing");
  stop();
});

console.log(failures === 0 ? "\nall checks passed" : `\n${String(failures)} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
