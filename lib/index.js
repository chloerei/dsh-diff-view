/**
 * dsh-diff-view — host half.
 *
 * Serves the working tree's git diff to the browser half over one read-only,
 * same-origin route. The route is deliberately small: it resolves a session's
 * working directory, shells out to git through the Harness subprocess service,
 * and returns JSON. Nothing here mutates the repository.
 *
 * @module dsh-diff-view
 */

import { collectWorkingTreeDiff } from "./git-diff.js";

/** Cordis plugin name. */
const name = "dsh-diff-view";

/** Services this plugin needs before `apply` runs. */
const inject = ["webServer", "connection", "sessions", "subprocess"];

/** The one route the browser half calls. */
const ROUTE_PATH = "/dsh-diff-view/diff";

/** Collected stdout ceiling; a larger patch is reported as truncated. */
const MAX_STDOUT_BYTES = 8 * 1024 * 1024;

/** Collected stderr ceiling. */
const MAX_STDERR_BYTES = 256 * 1024;

/** Whole-collection deadline. */
const GIT_TIMEOUT_MS = 20_000;

/** Milliseconds a terminated git process has to drain before it is killed. */
const GIT_GRACE_MS = 1_000;

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
 * Register the diff route.
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
   * Build the executor `collectWorkingTreeDiff` drives.
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
      const payload = await collectWorkingTreeDiff({ run: makeRun(cwd), cwd, signal: lifetime });
      sendJson(res, 200, { ...payload, generatedAt: new Date().toISOString() });
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

  ctx.effect(() => ctx.webServer.register({ kind: "exact", path: ROUTE_PATH, handler }), `dsh-diff-view: GET ${ROUTE_PATH}`);
}

export { apply, inject, name };
