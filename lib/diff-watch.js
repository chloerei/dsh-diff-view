/**
 * Change detection for one working tree, for the dsh-diff-view host half.
 *
 * The module answers one question — *has the diff a viewer is looking at
 * changed?* — and its whole shape is a cost argument:
 *
 * - A **check** is a `probe`: one cheap fingerprint of the tree. It never
 *   produces a patch and never reads a file's contents.
 * - A **collection** is a full diff, so it runs only when the probe moved.
 * - A **watch** is a directory observation, and it exists only to shorten the
 *   wait: an event schedules a check, it does not raise a payload by itself.
 *   Watches are capped, and re-armed from each payload so they follow the
 *   working tree the panel is actually showing.
 * - With no viewer there is no timer, no watcher, and no check.
 *
 * Everything with a cost lives behind the injected `probe`, `collect`, and
 * `watch` capabilities, so the scheduling above is testable with no Host, no
 * git, and no filesystem.
 *
 * @module dsh-diff-view/diff-watch
 */

import { dirname, join } from "node:path";

/** Milliseconds an event burst is folded into one check. */
const DEBOUNCE_MS = 300;

/**
 * The shortest gap between two checks, however fast events arrive.
 *
 * Debouncing folds a burst into one check; it does not bound a *stream*. A
 * watched directory that keeps churning — a log file, a `.DS_Store`, a lock
 * file in `.git`, anything written over and over — would otherwise ask for a
 * probe every debounce window for as long as it lasts. This floor is what makes
 * the worst case one probe a second instead of one every 300ms, and it leaves
 * an edit that follows a quiet moment untouched.
 */
const MIN_CHECK_MS = 1_000;

/** The gap between idle checks once the tree has settled. */
const IDLE_MS = 15_000;

/** The longest gap idle backoff reaches. */
const IDLE_MAX_MS = 60_000;

/** How many directories one working tree may hold watches on. */
const MAX_DIRECTORIES = 24;

/**
 * The directories one payload's diff can be changed through.
 *
 * Three are pinned and always watched: the session's directory (a project can
 * be initialized as a repository under it), the repository root (top-level
 * entries), and its administrative directory (the index, HEAD, and refs — every
 * staging, commit, and checkout). The parent directories of the changed files
 * come after them, sorted and capped, because a watch's only job is to notice
 * quickly and the idle probe still covers whatever the cap leaves out.
 *
 * A linked worktree records `.git` as a file, so its real administrative
 * directory is elsewhere and staging there is left to that same probe.
 *
 * @param payload - a collected diff payload.
 * @param cwd - the session's working directory.
 * @param limit - the most directories to return.
 * @returns absolute directory paths, pinned entries first.
 */
export function watchedDirectories(payload, cwd, limit = MAX_DIRECTORIES) {
  const wanted = [];
  const add = (path) => {
    if (typeof path === "string" && path !== "" && !wanted.includes(path)) wanted.push(path);
  };
  add(cwd);
  if (payload?.state === "ok") {
    add(payload.root);
    add(join(payload.root, ".git"));
    const extra = [];
    const addExtra = (path) => {
      if (typeof path === "string" && path !== "" && !extra.includes(path)) extra.push(path);
    };
    for (const file of payload.files ?? []) {
      addExtra(dirname(join(payload.root, file.path)));
      addExtra(dirname(join(payload.root, file.previousPath ?? file.path)));
    }
    extra.sort();
    for (const path of extra) {
      if (wanted.length >= limit) break;
      add(path);
    }
  }
  return wanted.slice(0, limit);
}

/**
 * The identity of a payload, ignoring when it was produced.
 *
 * The client compares this string with the one it last drew, so a pushed frame
 * whose diff is already on screen costs nothing, and the host compares it to
 * decide whether a collection is worth a frame at all.
 *
 * @param payload - a collected diff payload.
 * @returns a stable serialization of everything the panel draws.
 */
export function payloadKey(payload) {
  return JSON.stringify(payload, (key, value) => (key === "generatedAt" ? undefined : value));
}

/**
 * One working tree's change detector.
 *
 * Viewers subscribe, and the instance runs exactly while at least one is
 * subscribed: the first subscription starts the checks and the last
 * unsubscription stops the timers and closes every watch.
 */
export class DiffWatch {
  /** The working directory this detector reports on. */
  #cwd;
  /** `() => Promise<string|null>`: a cheap fingerprint, or null when unavailable. */
  #probe;
  /** `() => Promise<object>`: the full diff payload. */
  #collect;
  /** `(path, changed) => Promise<() => Promise<void>>`: arm one directory watch. */
  #watch;
  /** `(error) => void`: a failed check is reported, never fatal. */
  #onError;
  /** Viewers waiting for a payload. */
  #viewers = new Set();
  /** Armed directory watches, keyed by absolute path. */
  #watches = new Map();
  /** Directories whose watch is still initializing, so they are not armed twice. */
  #arming = new Set();
  /** The fingerprint the last check saw; null until one is taken. */
  #fingerprint = null;
  /** The payload identity the viewers last received. */
  #key = null;
  /** The pending burst timer, or null. */
  #debounce = null;
  /** The pending idle timer, or null. */
  #idle = null;
  /** The current idle gap, which doubles while the tree stays still. */
  #idleGap;
  /** When the last check started, which is the throttle's own clock. */
  #lastCheck = Number.NEGATIVE_INFINITY;
  /** Whether a check is running. */
  #checking = false;
  /** Whether a check was asked for while one was running. */
  #queued = false;
  /** Whether the instance has been stopped. */
  #stopped = true;
  /** Interval settings. */
  #debounceMs;
  #minCheckMs;
  #idleMs;
  #idleMaxMs;
  #maxDirectories;

  /**
   * @param options - the injected capabilities and the intervals.
   * @param options.cwd - the working directory this detector reports on.
   * @param options.probe - `() => Promise<string|null>`, the cheap fingerprint.
   * @param options.collect - `() => Promise<object>`, the full diff payload.
   * @param options.watch - `(path, changed) => Promise<() => Promise<void>>`, arm one
   *   directory watch; `changed` folds one filesystem event into a check.
   * @param options.onError - `(error) => void`, defaults to ignoring.
   * @param options.debounceMs - event-burst window.
   * @param options.minCheckMs - the floor between two checks.
   * @param options.idleMs - the first idle gap.
   * @param options.idleMaxMs - the longest idle gap.
   * @param options.maxDirectories - the watch cap.
   */
  constructor({
    cwd,
    probe,
    collect,
    watch,
    onError = () => {},
    debounceMs = DEBOUNCE_MS,
    minCheckMs = MIN_CHECK_MS,
    idleMs = IDLE_MS,
    idleMaxMs = IDLE_MAX_MS,
    maxDirectories = MAX_DIRECTORIES,
  }) {
    this.#cwd = cwd;
    this.#probe = probe;
    this.#collect = collect;
    this.#watch = watch;
    this.#onError = onError;
    this.#debounceMs = debounceMs;
    this.#minCheckMs = minCheckMs;
    this.#idleMs = idleMs;
    this.#idleMaxMs = idleMaxMs;
    this.#maxDirectories = maxDirectories;
    this.#idleGap = idleMs;
  }

  /** How many viewers are waiting for a payload. */
  get viewers() {
    return this.#viewers.size;
  }

  /** The directories currently watched, for tests and diagnostics. */
  get directories() {
    return [...this.#watches.keys()];
  }

  /**
   * Add one viewer and start the detector if it is the first.
   * @param viewer - `(payload) => void`, called for each changed payload.
   * @returns the unsubscription; the last one stops the detector.
   */
  subscribe(viewer) {
    this.#viewers.add(viewer);
    if (this.#viewers.size === 1) this.#start();
    let live = true;
    return () => {
      if (!live) return;
      live = false;
      this.#viewers.delete(viewer);
      if (this.#viewers.size === 0) void this.stop();
    };
  }

  /**
   * Stop every timer and close every watch.
   * @returns once the watches have closed.
   */
  async stop() {
    this.#stopped = true;
    this.#viewers.clear();
    if (this.#debounce !== null) {
      clearTimeout(this.#debounce);
      this.#debounce = null;
    }
    if (this.#idle !== null) {
      clearTimeout(this.#idle);
      this.#idle = null;
    }
    await this.#closeWatches();
  }

  /** Arm the idle timer, start the first check, and take the baseline. */
  #start() {
    this.#stopped = false;
    this.#fingerprint = null;
    this.#key = null;
    this.#idleGap = this.#idleMs;
    void this.#check();
  }

  /**
   * Probe, and collect only when the tree actually moved.
   *
   * One check runs at a time; an event that arrives mid-check is remembered and
   * runs straight afterwards, so a burst cannot pile up collections.
   */
  async #check() {
    if (this.#stopped) return;
    if (this.#checking) {
      this.#queued = true;
      return;
    }
    this.#checking = true;
    this.#lastCheck = Date.now();
    try {
      const fingerprint = await this.#probe();
      if (this.#stopped) return;
      if (fingerprint !== null && fingerprint === this.#fingerprint) {
        this.#idleGap = Math.min(this.#idleGap * 2, this.#idleMaxMs);
        return;
      }
      /* Retry soon: something moved, and the move is what the panel is waiting
         for. The fingerprint is only adopted once the diff behind it was read,
         so a collection that fails is retried rather than assumed to be news
         the viewers already have. */
      this.#idleGap = this.#idleMs;
      const payload = await this.#collect();
      this.#fingerprint = fingerprint;
      if (this.#stopped) return;
      await this.#arm(payload);
      const key = payloadKey(payload);
      if (key === this.#key) return;
      this.#key = key;
      for (const viewer of this.#viewers) viewer(payload);
    } catch (error) {
      this.#onError(error);
    } finally {
      this.#checking = false;
      if (this.#stopped) {
        await this.#closeWatches();
        return;
      }
      this.#scheduleIdle();
      if (this.#queued) {
        this.#queued = false;
        this.#schedule();
      }
    }
  }

  /**
   * Fold one filesystem event into a check.
   *
   * A burst keeps one pending timer rather than one per event — an editor
   * writing a file in three passes is one check, not three — and the wait
   * carries the throttle as well, so a directory that never stops churning
   * cannot buy more than one check a second.
   */
  #schedule() {
    if (this.#stopped || this.#debounce !== null) return;
    const since = Date.now() - this.#lastCheck;
    const wait = Math.max(this.#debounceMs, this.#minCheckMs - since);
    this.#debounce = setTimeout(() => {
      this.#debounce = null;
      void this.#check();
    }, wait);
    this.#debounce.unref?.();
  }

  /** Re-arm the idle timer at the current gap. */
  #scheduleIdle() {
    if (this.#idle !== null) clearTimeout(this.#idle);
    this.#idle = setTimeout(() => {
      this.#idle = null;
      void this.#check();
    }, this.#idleGap);
    this.#idle.unref?.();
  }

  /**
   * Point the watches at the directories this payload's diff can be changed
   * through, closing the ones it no longer touches.
   * @param payload - the payload just collected.
   */
  async #arm(payload) {
    const wanted = watchedDirectories(payload, this.#cwd, this.#maxDirectories);
    for (const [path, close] of [...this.#watches]) {
      if (wanted.includes(path)) continue;
      this.#watches.delete(path);
      void close().catch(this.#onError);
    }
    for (const path of wanted) {
      if (this.#watches.has(path) || this.#arming.has(path)) continue;
      this.#arming.add(path);
      try {
        const close = await this.#watch(path, () => this.#schedule());
        if (this.#stopped) {
          void close().catch(this.#onError);
          return;
        }
        this.#watches.set(path, close);
      } catch (error) {
        /* An unwatchable directory is not fatal: the idle probe still covers it. */
        this.#onError(error);
      } finally {
        this.#arming.delete(path);
      }
    }
  }

  /** Close every armed watch. */
  async #closeWatches() {
    const closing = [...this.#watches.values()];
    this.#watches.clear();
    await Promise.all(closing.map((close) => Promise.resolve(close()).catch(this.#onError)));
  }
}
