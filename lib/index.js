/**
 * dsh-diff-view — host half.
 *
 * Serves the working tree's git diff to the browser half over two read-only,
 * same-origin routes: one request/response route that answers with the diff,
 * and one event stream that pushes a new payload when the diff actually
 * changes. The routes are deliberately small: they resolve a session's working
 * directory, shell out to git through the Harness subprocess service, and
 * return JSON. Nothing here mutates the repository.
 *
 * Auto-refresh is the event stream. A viewer subscribes by connecting, and the
 * detector behind that connection probes the working tree cheaply — one
 * `git status` — and runs a full collection only when the probe says the tree
 * moved. Directory watches shorten the wait, and all of it exists only while
 * someone is watching.
 *
 * @module dsh-diff-view
 */

import { DiffWatch } from "./diff-watch.js";
import { collectWorkingTreeDiff, probeWorkingTree } from "./git-diff.js";

/** Cordis plugin name. */
const name = "dsh-diff-view";

/** Services this plugin needs before `apply` runs. */
const inject = ["webServer", "connection", "sessions", "subprocess"];

/** The route the browser half reads a diff from. */
const ROUTE_PATH = "/dsh-diff-view/diff";

/** The event stream the browser half subscribes to. */
const EVENTS_PATH = "/dsh-diff-view/events";

/** Collected stdout ceiling; a larger patch is reported as truncated. */
const MAX_STDOUT_BYTES = 8 * 1024 * 1024;

/** Collected stderr ceiling. */
const MAX_STDERR_BYTES = 256 * 1024;

/** Whole-collection deadline. */
const GIT_TIMEOUT_MS = 20_000;

/** Whole-fingerprint deadline; a probe that hangs is worth abandoning early. */
const PROBE_TIMEOUT_MS = 10_000;

/** Milliseconds a terminated git process has to drain before it is killed. */
const GIT_GRACE_MS = 1_000;

/** Largest payload pushed as an event frame; a bigger one is announced instead. */
const PUSH_MAX_BYTES = 512 * 1024;

/** Idle keep-alive comment on an open event stream. */
const HEARTBEAT_MS = 25_000;

/**
 * Environment every git call runs with.
 *
 * `GIT_TERMINAL_PROMPT=0` keeps a credential prompt from hanging the request,
 * `GIT_OPTIONAL_LOCKS=0` stops a read-only diff from taking the index lock, and
 * `LC_ALL=C` keeps git's own diagnostics stable.
 */
const GIT_ENV = {
  GIT_CONFIG_COUNT: "0",
  GIT_TERMINAL_PROMPT: "0",
  GIT_OPTIONAL_LOCKS: "0",
  LC_ALL: "C",
};

/**
 * Write one JSON response.
 * @param res - the Node response.
 * @param status - HTTP status code.
 * @param payload - JSON-serializable body.
 */
function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(payload));
}

/**
 * One server-sent event.
 * @param event - the event name the browser subscribes to.
 * @param data - one line of JSON (already serialized, so it holds no newline).
 * @returns the wire frame.
 */
function sseFrame(event, data) {
  return `event: ${event}\ndata: ${data}\n\n`;
}

/**
 * Register the diff route and its event stream.
 * @param ctx - the Host context carrying the declared services.
 */
function apply(ctx) {
  /** Resolved absolute `git` path, or the bare name as a fallback. */
  let program;
  /**
   * Resolve the git executable once; a Host without one gets a clear error from
   * the spawn itself rather than from here.
   * @returns the program to pass as `argv[0]`.
   */
  const gitProgram = async () => {
    if (program !== undefined) return program;
    try {
      program = await ctx.subprocess.resolveExecutable("git");
    } catch {
      program = "git";
    }
    return program;
  };

  /**
   * Build the executor both git calls drive.
   *
   * The collector resolves the repository root itself and asks for that
   * directory per call, so the third argument overrides the default.
   *
   * @param defaultCwd - the session's working directory.
   * @returns `(args, signal, cwd) => Promise<{ exitCode, stdout, stderr, lossy }>`.
   */
  const makeRun = (defaultCwd) => async (args, signal, cwd) => {
    const message = (error) => (error instanceof Error ? error.message : String(error));
    let handle;
    try {
      handle = ctx.subprocess.spawn({
        argv: [await gitProgram(), "-c", "core.quotepath=false", ...args],
        cwd: cwd ?? defaultCwd,
        stdio: {
          stdin: "ignore",
          stdout: { maxBytes: MAX_STDOUT_BYTES },
          stderr: { maxBytes: MAX_STDERR_BYTES },
        },
        graceMs: GIT_GRACE_MS,
        signal,
        env: GIT_ENV,
      });
    } catch (error) {
      return { exitCode: null, stdout: "", stderr: message(error), lossy: false };
    }
    let outcome;
    try {
      outcome = await handle.done;
    } catch (error) {
      return { exitCode: null, stdout: "", stderr: message(error), lossy: false };
    }
    const stdout = handle.collected.stdout?.readFrom(0) ?? { text: "", lossy: false };
    const stderr = handle.collected.stderr?.readFrom(0) ?? { text: "", lossy: false };
    /* A killed command still settles `done`, so abort has to be reported here. */
    if (signal?.aborted === true) throw new Error(`git ${args.join(" ")} was aborted`);
    return { exitCode: outcome.exitCode, stdout: stdout.text, stderr: stderr.text, lossy: stdout.lossy === true };
  };

  /**
   * Decide which directory to inspect: an explicit absolute path, the session's
   * recorded cwd, or — for a session whose header the Host no longer holds —
   * the sandbox policy's workspace root.
   *
   * @param request - the parsed request URL.
   * @returns the absolute directory, or null when nothing identifies one.
   */
  const resolveCwd = async (request) => {
    const explicit = request.searchParams.get("path");
    if (explicit !== null && explicit.startsWith("/")) return explicit;
    const sessionId = request.searchParams.get("sessionId");
    if (sessionId !== null && sessionId !== "") {
      const live = ctx.sessions.get(sessionId)?.header?.cwd;
      if (typeof live === "string" && live !== "") return live;
      const persistence = ctx.get("sessionPersistence");
      if (persistence !== undefined) {
        try {
          const stored = (await persistence.stat(sessionId))?.header?.cwd;
          if (typeof stored === "string" && stored !== "") return stored;
        } catch {
          /* An unreadable session log falls through to the policy root. */
        }
      }
    }
    const root = ctx.get("sandboxPolicy")?.workspaceRoot;
    return typeof root === "string" && root !== "" ? root : null;
  };

  /**
   * Run one full collection for a directory.
   * @param cwd - the directory to inspect.
   * @param signal - aborts every git invocation.
   * @returns the diff payload, stamped with when it was produced.
   */
  const collectDiff = async (cwd, signal) => {
    const payload = await collectWorkingTreeDiff({ run: makeRun(cwd), cwd, signal });
    return { ...payload, generatedAt: new Date().toISOString() };
  };

  /**
   * Take one cheap fingerprint of a directory's working tree.
   * @param cwd - the directory to fingerprint.
   * @param signal - aborts the probe.
   * @returns the digest, or null when even the fingerprint could not be read.
   */
  const probeDiff = async (cwd, signal) => {
    try {
      return await probeWorkingTree({ run: makeRun(cwd), cwd, signal });
    } catch {
      /* A fingerprint that cannot be taken is not a diff failure: the detector
         falls back to collecting on every check. */
      return null;
    }
  };

  /** Live change detectors, keyed by working directory, shared by every viewer. */
  const detectors = new Map();

  /** Open event streams, so unloading the plugin can end them. */
  const streams = new Set();

  /**
   * The detector for one directory, started on its first viewer.
   *
   * @param cwd - the working directory to watch.
   * @returns the detector and the controller that ends its watches.
   */
  const detectorFor = (cwd) => {
    const existing = detectors.get(cwd);
    if (existing !== undefined) return existing;
    const controller = new AbortController();
    const entry = { controller, detector: undefined };
    const report = (error) => {
      if (error instanceof Error && error.name === "AbortError") return;
      ctx.logger?.warn?.(error);
    };
    entry.detector = new DiffWatch({
      cwd,
      probe: () => probeDiff(cwd, AbortSignal.any([controller.signal, AbortSignal.timeout(PROBE_TIMEOUT_MS)])),
      collect: () => collectDiff(cwd, AbortSignal.any([controller.signal, AbortSignal.timeout(GIT_TIMEOUT_MS)])),
      watch: async (path, changed) => {
        const fs = ctx.get("fs");
        if (fs === undefined || typeof fs.watch !== "function") {
          throw new Error("no filesystem watch service is mounted");
        }
        const target = await fs.resolve(path);
        return await fs.watch(
          target,
          (error) => {
            if (error !== undefined) report(error);
            changed();
          },
          controller.signal
        );
      },
      onError: report,
    });
    detectors.set(cwd, entry);
    return entry;
  };

  const handler = async (req, res) => {
    const rejection = ctx.connection.requestRejection(req);
    if (rejection !== undefined) {
      res.statusCode = rejection;
      res.end();
      return;
    }
    if (req.method !== "GET") {
      res.statusCode = 405;
      res.setHeader("allow", "GET");
      res.end();
      return;
    }

    const request = new URL(String(req.url ?? "/"), "http://localhost");
    const cwd = await resolveCwd(request);
    if (cwd === null) {
      sendJson(res, 404, { state: "error", message: "No working directory is known for this request." });
      return;
    }

    const deadline = AbortSignal.timeout(GIT_TIMEOUT_MS);
    const clientGone = new AbortController();
    const onClose = () => {
      if (!res.writableEnded) clientGone.abort();
    };
    res.on("close", onClose);
    const lifetime = AbortSignal.any([deadline, clientGone.signal]);
    try {
      const payload = await collectDiff(cwd, lifetime);
      sendJson(res, 200, payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, deadline.aborted ? 504 : 500, {
        state: "error",
        cwd,
        message: deadline.aborted ? `git did not finish within ${String(GIT_TIMEOUT_MS)}ms` : message,
      });
    } finally {
      res.off("close", onClose);
    }
  };

  /**
   * The event stream: one connection per open panel.
   *
   * Subscribing is what starts the detector, so closing the panel — or hiding
   * the page, which the browser half does — stops every timer and watch the
   * panel was paying for.
   */
  const streamHandler = async (req, res) => {
    const rejection = ctx.connection.requestRejection(req);
    if (rejection !== undefined) {
      res.statusCode = rejection;
      res.end();
      return;
    }
    if (req.method !== "GET") {
      res.statusCode = 405;
      res.setHeader("allow", "GET");
      res.end();
      return;
    }

    const request = new URL(String(req.url ?? "/"), "http://localhost");
    const cwd = await resolveCwd(request);
    if (cwd === null) {
      sendJson(res, 404, { state: "error", message: "No working directory is known for this request." });
      return;
    }

    const entry = detectorFor(cwd);
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write(": connected\n\n");
    streams.add(res);

    const unsubscribe = entry.detector.subscribe((payload) => {
      if (res.writableEnded || res.destroyed) return;
      const data = JSON.stringify(payload);
      /* A diff too large to push is announced rather than carried: the browser
         re-reads the route, which is a request either way but not a held copy. */
      const frame = data.length > PUSH_MAX_BYTES ? sseFrame("changed", "{}") : sseFrame("diff", data);
      try {
        res.write(frame);
      } catch (error) {
        ctx.logger?.warn?.(error);
      }
    });

    const heartbeat = setInterval(() => {
      if (res.writableEnded || res.destroyed) return;
      try {
        res.write(": ping\n\n");
      } catch {
        /* The close handler below is what tears the stream down. */
      }
    }, HEARTBEAT_MS);
    heartbeat.unref?.();

    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      res.off("close", cleanup);
      streams.delete(res);
      unsubscribe();
      /* The last viewer takes the detector — and its watches, and any git
         process it already started — with it. */
      if (entry.detector.viewers === 0) {
        detectors.delete(cwd);
        entry.controller.abort();
      }
    };
    res.on("close", cleanup);
    res.on("error", cleanup);
  };

  ctx.effect(() => {
    const disposeDiff = ctx.webServer.register({ kind: "exact", path: ROUTE_PATH, handler });
    const disposeEvents = ctx.webServer.register({ kind: "exact", path: EVENTS_PATH, handler: streamHandler });
    return () => {
      disposeDiff();
      disposeEvents();
      for (const res of streams) res.end();
      streams.clear();
      for (const entry of detectors.values()) {
        entry.controller.abort();
        void entry.detector.stop();
      }
      detectors.clear();
    };
  }, `dsh-diff-view: GET ${ROUTE_PATH} and ${EVENTS_PATH}`);
}

export { apply, inject, name };
