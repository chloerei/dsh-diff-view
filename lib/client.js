/**
 * dsh-diff-viewer — browser half.
 *
 * Registers one right-sidebar tab type. The entry appears in the right
 * sidebar's tab-add ("+") guide, and choosing it opens a tab whose body fetches
 * the Host's read-only diff route for the current session's working directory.
 *
 * The file is a Harness client bundle: `window.__ModuleLoader__.load` with a
 * factory that `require`s the runtime's shared modules. It is hand-written and
 * needs no build step.
 */
window.__ModuleLoader__.load({
  id: "dsh-diff-viewer",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const react = require("react");
    const jsxRuntime = require("react/jsx-runtime");
    const jsx = jsxRuntime.jsx;
    const jsxs = jsxRuntime.jsxs;

    /** Dictionary namespace owned by this plugin. */
    const NS = "dshDiffViewer";
    /** Tab-type id; also the slot key for the body seat. */
    const VIEWER_ID = "dsh-diff-viewer";
    /** Tab kind discriminator. */
    const KIND = "dsh-diff-viewer";
    /** Host route the body reads. */
    const ROUTE = "/dsh-diff-viewer/diff";
    /** Beyond this many hunk lines a file starts collapsed. */
    const EXPAND_ALL_LIMIT = 1200;
    /** Hard ceiling on lines rendered for one file. */
    const MAX_RENDERED_LINES = 2500;

    const css = `
.dsh-diff{display:flex;flex-direction:column;height:100%;min-height:0;color:var(--dsw-alias-label-primary);font-size:12px}
.dsh-diff__bar{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);flex:none;min-width:0}
.dsh-diff__barIcon{flex:none;color:var(--dsw-alias-label-secondary);display:flex}
.dsh-diff__repo{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}
.dsh-diff__branch{font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-diff__root{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left}
.dsh-diff__action{flex:none;border:.5px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:6px;padding:3px 8px;font:inherit;font-size:11px;cursor:pointer}
.dsh-diff__action:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.dsh-diff__action:disabled{opacity:.5;cursor:default}
.dsh-diff__counts{display:flex;gap:8px;padding:6px 10px;border-bottom:.5px solid var(--dsw-alias-border-l1);font-size:11px;color:var(--dsw-alias-label-secondary);flex:none;flex-wrap:wrap}
.dsh-diff__countAdd{color:var(--dsw-alias-state-success-primary)}
.dsh-diff__countDel{color:var(--dsw-alias-state-error-primary)}
.dsh-diff__scroll{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain}
.dsh-diff__notice{margin:8px 10px;padding:8px 10px;border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.5}
.dsh-diff__empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;height:100%;padding:24px;text-align:center;color:var(--dsw-alias-label-secondary)}
.dsh-diff__emptyIcon{color:var(--dsw-alias-label-secondary);opacity:.8}
.dsh-diff__emptyTitle{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dsh-diff__emptyBody{font-size:12px;line-height:1.6;max-width:34ch}
.dsh-diff__emptyPath{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;word-break:break-all;color:var(--dsw-alias-label-secondary)}
.dsh-diff__file{border-bottom:.5px solid var(--dsw-alias-border-l1)}
.dsh-diff__fileHead{display:flex;align-items:center;gap:6px;width:100%;padding:6px 10px;background:var(--dsw-alias-bg-layer-1);border:0;font:inherit;color:inherit;text-align:left;cursor:pointer;min-width:0}
.dsh-diff__fileHead:hover{background:var(--dsw-alias-bg-layer-2)}
.dsh-diff__caret{flex:none;width:10px;color:var(--dsw-alias-label-secondary);font-size:9px}
.dsh-diff__badge{flex:none;font-size:10px;line-height:1;padding:3px 5px;border-radius:4px;text-transform:uppercase;letter-spacing:.02em;border:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
.dsh-diff__badge[data-status=added]{color:var(--dsw-alias-state-success-primary)}
.dsh-diff__badge[data-status=deleted]{color:var(--dsw-alias-state-error-primary)}
.dsh-diff__badge[data-status=conflicted]{color:var(--dsw-alias-state-warn-primary)}
.dsh-diff__badge[data-status=renamed],.dsh-diff__badge[data-status=copied]{color:var(--dsw-alias-brand-primary)}
.dsh-diff__path{flex:1;min-width:0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left}
.dsh-diff__stat{flex:none;display:flex;gap:5px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px}
.dsh-diff__statAdd{color:var(--dsw-alias-state-success-primary)}
.dsh-diff__statDel{color:var(--dsw-alias-state-error-primary)}
.dsh-diff__chip{flex:none;font-size:10px;color:var(--dsw-alias-label-secondary);border:.5px solid var(--dsw-alias-border-l1);border-radius:4px;padding:1px 4px}
.dsh-diff__hunk{border-top:.5px solid var(--dsw-alias-border-l1)}
.dsh-diff__hunkHead{padding:3px 10px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);white-space:pre;overflow-x:auto}
.dsh-diff__line{display:flex;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:1.55;white-space:pre}
.dsh-diff__no{flex:none;width:38px;padding:0 6px;text-align:right;color:var(--dsw-alias-label-secondary);opacity:.75;user-select:none;background:var(--dsw-alias-bg-layer-1)}
.dsh-diff__sign{flex:none;width:12px;text-align:center;color:var(--dsw-alias-label-secondary);user-select:none}
.dsh-diff__code{flex:1;padding-right:10px;min-width:0}
.dsh-diff__line--add{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 12%,transparent)}
.dsh-diff__line--delete{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent)}
.dsh-diff__line--add .dsh-diff__sign{color:var(--dsw-alias-state-success-primary)}
.dsh-diff__line--delete .dsh-diff__sign{color:var(--dsw-alias-state-error-primary)}
.dsh-diff__line--meta{color:var(--dsw-alias-label-secondary);font-style:italic}
.dsh-diff__untracked{padding:8px 10px;display:flex;flex-direction:column;gap:4px}
.dsh-diff__untrackedTitle{font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary);text-transform:uppercase;letter-spacing:.03em}
.dsh-diff__untrackedPath{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;color:var(--dsw-alias-label-secondary);word-break:break-all}
.dsh-diff__spinner{width:13px;height:13px;border:1.5px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-label-secondary);border-radius:50%;animation:dsh-diff-spin .8s linear infinite}
@keyframes dsh-diff-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.dsh-diff__spinner{animation-duration:2.4s}}
`;

    const CSS_ID = "dsh-diff-viewer/Viewer.css";
    if (typeof document !== "undefined" && document.querySelector(`style[data-plugin-css=${JSON.stringify(CSS_ID)}]`) === null) {
      const tag = document.createElement("style");
      tag.dataset.plugin = VIEWER_ID;
      tag.dataset.pluginCss = CSS_ID;
      tag.textContent = css;
      document.head.appendChild(tag);
    }

    const en = {
      "tab.title": "Git Diff",
      "guide.title": "Git diff",
      "guide.description": "Review the working tree's changes",
      loading: "Reading git diff…",
      refresh: "Refresh",
      "branch.detached": "detached HEAD",
      "branch.unborn": "no commits yet",
      "counts.files": "{count} files",
      "counts.untracked": "{count} untracked",
      clean: "The working tree has no changes.",
      "untracked.title": "Untracked files",
      "noGit.title": "Not a git project",
      "noGit.body": "This project has no .git directory, so there is no git diff to show.",
      "noGit.hint": "Initialize a repository with git init to start tracking changes.",
      "error.title": "Could not read the git diff",
      retry: "Retry",
      "binary": "Binary file — no textual diff",
      "truncated": "The diff exceeded the viewer's collection limit; the tail is missing.",
      "hidden.lines": "… {count} more lines are not rendered",
      "directory": "Directory",
      "status.modified": "mod",
      "status.added": "new",
      "status.deleted": "del",
      "status.renamed": "ren",
      "status.copied": "cpy",
      "status.conflicted": "conflict",
      "status.untracked": "new"
    };

    const zh = {
      "tab.title": "Git 差异",
      "guide.title": "Git 差异",
      "guide.description": "查看工作区的改动",
      loading: "正在读取 git diff…",
      refresh: "刷新",
      "branch.detached": "游离 HEAD",
      "branch.unborn": "尚无提交",
      "counts.files": "{count} 个文件",
      "counts.untracked": "{count} 个未跟踪",
      clean: "工作区没有改动。",
      "untracked.title": "未跟踪的文件",
      "noGit.title": "非 Git 项目",
      "noGit.body": "该项目下没有 .git 目录，无法显示 git diff。",
      "noGit.hint": "可以用 git init 初始化仓库后再查看。",
      "error.title": "无法读取 git diff",
      retry: "重试",
      "binary": "二进制文件，没有文本差异",
      "truncated": "差异超出查看器的收集上限，末尾内容已缺失。",
      "hidden.lines": "… 还有 {count} 行未渲染",
      "directory": "目录",
      "status.modified": "改",
      "status.added": "增",
      "status.deleted": "删",
      "status.renamed": "移",
      "status.copied": "复",
      "status.conflicted": "冲突",
      "status.untracked": "新"
    };

    /**
     * The guide entry's artwork: a branch glyph in the surrounding text color.
     * @param props - the owner-supplied size and class.
     * @returns a decorative SVG.
     */
    function GitBranchIcon({ size = 22, className }) {
      return jsx("svg", {
        width: size,
        height: size,
        viewBox: "0 0 16 16",
        fill: "none",
        className,
        "aria-hidden": "true",
        children: jsxs("g", {
          stroke: "currentColor",
          strokeWidth: "1.2",
          strokeLinecap: "round",
          strokeLinejoin: "round",
          children: [
            jsx("circle", { cx: "4.6", cy: "3.4", r: "1.7" }),
            jsx("circle", { cx: "4.6", cy: "12.6", r: "1.7" }),
            jsx("circle", { cx: "11.4", cy: "6.2", r: "1.7" }),
            jsx("path", { d: "M4.6 5.1v5.8" }),
            jsx("path", { d: "M11.4 7.9c0 2.3-2.1 3.1-4.2 3.4" })
          ]
        })
      });
    }

    /**
     * One side of the two line-number gutters.
     * @param props - the number, or nothing for a line the side does not own.
     * @returns the gutter cell.
     */
    function Gutter({ value }) {
      return jsx("span", { className: "dsh-diff__no", children: value === undefined || value === null ? "" : String(value) });
    }

    /**
     * Render one file's hunks, capped so a huge file cannot stall the panel.
     * @param props - the file record and the active translator.
     * @returns the hunk list.
     */
    function Hunks({ file, t }) {
      const rendered = [];
      let hidden = 0;
      let budget = MAX_RENDERED_LINES;
      for (let h = 0; h < file.hunks.length; h += 1) {
        const hunk = file.hunks[h];
        const lines = [];
        for (const line of hunk.lines) {
          if (budget <= 0) {
            hidden += 1;
            continue;
          }
          budget -= 1;
          const sign = line.kind === "add" ? "+" : line.kind === "delete" ? "-" : line.kind === "meta" ? "\\" : " ";
          lines.push(
            jsxs(
              "div",
              {
                className: `dsh-diff__line dsh-diff__line--${line.kind}`,
                children: [
                  jsx(Gutter, { value: line.old }),
                  jsx(Gutter, { value: line.new }),
                  jsx("span", { className: "dsh-diff__sign", children: sign }),
                  jsx("span", { className: "dsh-diff__code", children: line.text === "" ? "\u00a0" : line.text })
                ]
              },
              `${String(h)}:${String(rendered.length)}`
            )
          );
        }
        rendered.push(
          jsxs(
            "div",
            {
              className: "dsh-diff__hunk",
              children: [jsx("div", { className: "dsh-diff__hunkHead", children: hunk.header }), lines]
            },
            `hunk-${String(h)}`
          )
        );
      }
      return jsxs(react.Fragment, {
        children: [rendered, hidden === 0 ? null : jsx("div", { className: "dsh-diff__notice", children: t("hidden.lines", { count: hidden }) })]
      });
    }

    /**
     * One collapsible file section.
     * @param props - the file, its open state, the toggle, and the active translator.
     * @returns the section.
     */
    function FileBlock({ file, open, onToggle, t }) {
      const label = t(`status.${file.status}`);
      const heading = jsxs("button", {
        type: "button",
        className: "dsh-diff__fileHead",
        "aria-expanded": open,
        onClick: onToggle,
        children: [
          jsx("span", { className: "dsh-diff__caret", children: open ? "\u25be" : "\u25b8" }),
          jsx("span", { className: "dsh-diff__badge", "data-status": file.status, children: label }),
          jsx("span", { className: "dsh-diff__path", title: file.path, children: file.path }),
          file.previousPath === null || file.previousPath === undefined
            ? null
            : jsx("span", { className: "dsh-diff__chip", title: file.previousPath, children: "\u2190" }),
          file.staged && file.unstaged ? jsx("span", { className: "dsh-diff__chip", children: "staged+wt" }) : null,
          !file.staged && file.unstaged ? jsx("span", { className: "dsh-diff__chip", children: "wt" }) : null,
          file.binary
            ? null
            : jsxs("span", {
                className: "dsh-diff__stat",
                children: [
                  jsx("span", { className: "dsh-diff__statAdd", children: `+${String(file.additions)}` }),
                  jsx("span", { className: "dsh-diff__statDel", children: `-${String(file.deletions)}` })
                ]
              })
        ]
      });
      let body = null;
      if (open) {
        body = file.binary
          ? jsx("div", { className: "dsh-diff__notice", children: t("binary") })
          : file.hunks.length === 0
            ? jsx("div", { className: "dsh-diff__notice", children: t("binary") })
            : jsx(Hunks, { file, t });
      }
      return jsxs("section", { className: "dsh-diff__file", children: [heading, body] });
    }

    /**
     * The tab body: read the Host route and render the result.
     * @param props - the session-scoped slot props (`sessionId` and `t`).
     * @returns the diff panel.
     */
    function DiffViewer(props) {
      const sessionId = props.sessionId;
      const t = props.t;
      const [nonce, setNonce] = react.useState(0);
      const [state, setState] = react.useState({ phase: "loading" });
      const [openMap, setOpenMap] = react.useState({});

      react.useEffect(() => {
        const lifetime = new AbortController();
        setState({ phase: "loading" });
        const url = `${ROUTE}?sessionId=${encodeURIComponent(String(sessionId ?? ""))}`;
        fetch(url, { signal: lifetime.signal, credentials: "same-origin", headers: { accept: "application/json" } })
          .then(async (response) => {
            const payload = await response.json().catch(() => null);
            if (!response.ok) {
              const message = payload !== null && typeof payload.message === "string" ? payload.message : `HTTP ${String(response.status)}`;
              throw new Error(message);
            }
            if (payload === null || typeof payload !== "object") throw new Error("malformed response");
            return payload;
          })
          .then((payload) => {
            if (!lifetime.signal.aborted) setState({ phase: "ready", payload });
          })
          .catch((error) => {
            if (lifetime.signal.aborted) return;
            setState({ phase: "error", message: error instanceof Error ? error.message : String(error) });
          });
        return () => lifetime.abort();
      }, [sessionId, nonce]);

      const refresh = () => {
        setNonce((value) => value + 1);
      };

      if (state.phase === "loading") {
        return jsxs("div", {
          className: "dsh-diff__empty",
          children: [jsx("span", { className: "dsh-diff__spinner" }), jsx("div", { className: "dsh-diff__emptyBody", children: t("loading") })]
        });
      }

      if (state.phase === "error") {
        return jsxs("div", {
          className: "dsh-diff__empty",
          children: [
            jsx(GitBranchIcon, { size: 32, className: "dsh-diff__emptyIcon" }),
            jsx("div", { className: "dsh-diff__emptyTitle", children: t("error.title") }),
            jsx("div", { className: "dsh-diff__emptyBody", children: state.message }),
            jsx("button", { type: "button", className: "dsh-diff__action", onClick: refresh, children: t("retry") })
          ]
        });
      }

      const payload = state.payload;
      if (payload.state === "no-git") {
        return jsxs("div", {
          className: "dsh-diff__empty",
          children: [
            jsx(GitBranchIcon, { size: 32, className: "dsh-diff__emptyIcon" }),
            jsx("div", { className: "dsh-diff__emptyTitle", children: t("noGit.title") }),
            jsx("div", { className: "dsh-diff__emptyBody", children: t("noGit.body") }),
            jsx("div", { className: "dsh-diff__emptyPath", children: payload.cwd }),
            jsx("div", { className: "dsh-diff__emptyBody", children: t("noGit.hint") }),
            jsx("button", { type: "button", className: "dsh-diff__action", onClick: refresh, children: t("refresh") })
          ]
        });
      }

      if (payload.state !== "ok") {
        return jsxs("div", {
          className: "dsh-diff__empty",
          children: [
            jsx("div", { className: "dsh-diff__emptyTitle", children: t("error.title") }),
            jsx("div", { className: "dsh-diff__emptyBody", children: String(payload.message ?? "") }),
            jsx("button", { type: "button", className: "dsh-diff__action", onClick: refresh, children: t("retry") })
          ]
        });
      }

      const files = payload.files ?? [];
      const untracked = payload.untracked ?? [];
      const counts = payload.counts ?? { files: 0, untracked: 0, additions: 0, deletions: 0 };
      const totalLines = files.reduce((sum, file) => sum + (file.hunks ?? []).reduce((inner, hunk) => inner + hunk.lines.length, 0), 0);
      const defaultOpen = totalLines <= EXPAND_ALL_LIMIT;
      const isOpen = (file) => (file.path in openMap ? openMap[file.path] : defaultOpen);
      const toggle = (path) => {
        setOpenMap((previous) => ({ ...previous, [path]: !(path in previous ? previous[path] : defaultOpen) }));
      };

      const branchLabel = payload.unborn ? t("branch.unborn") : payload.detached ? t("branch.detached") : String(payload.branch ?? "");

      const bar = jsxs("div", {
        className: "dsh-diff__bar",
        children: [
          jsx("span", { className: "dsh-diff__barIcon", children: jsx(GitBranchIcon, { size: 16 }) }),
          jsxs("span", {
            className: "dsh-diff__repo",
            children: [
              jsx("span", { className: "dsh-diff__branch", title: `${String(payload.branch ?? "")} ${String(payload.head ?? "")}`, children: branchLabel }),
              jsx("span", { className: "dsh-diff__root", title: payload.root, children: payload.root })
            ]
          }),
          jsx("button", { type: "button", className: "dsh-diff__action", onClick: refresh, title: t("refresh"), children: t("refresh") })
        ]
      });

      const summary = jsxs("div", {
        className: "dsh-diff__counts",
        children: [
          jsx("span", { children: t("counts.files", { count: counts.files }) }),
          counts.untracked > 0 ? jsx("span", { children: t("counts.untracked", { count: counts.untracked }) }) : null,
          jsx("span", { className: "dsh-diff__statAdd", children: `+${String(counts.additions)}` }),
          jsx("span", { className: "dsh-diff__statDel", children: `-${String(counts.deletions)}` }),
          payload.head === null || payload.head === undefined ? null : jsx("span", { children: String(payload.head) })
        ]
      });

      const body = [];
      if (payload.truncated === true) body.push(jsx("div", { className: "dsh-diff__notice", children: t("truncated") }, "truncated"));
      if (files.length === 0) body.push(jsx("div", { className: "dsh-diff__notice", children: t("clean") }, "clean"));
      for (const file of files) {
        body.push(jsx(FileBlock, { file, open: isOpen(file), onToggle: () => toggle(file.path), t }, file.path));
      }
      if (untracked.length > 0) {
        body.push(
          jsxs(
            "div",
            {
              className: "dsh-diff__untracked",
              children: [
                jsx("div", { className: "dsh-diff__untrackedTitle", children: t("untracked.title") }),
                ...untracked.map((entry) => jsx("div", { className: "dsh-diff__untrackedPath", children: entry.path }, entry.path))
              ]
            },
            "untracked"
          )
        );
      }

      return jsxs("div", {
        className: "dsh-diff",
        children: [bar, summary, jsx("div", { className: "dsh-diff__scroll", children: body })]
      });
    }

    /** Services this client plugin consumes. */
    const inject = ["slots", "locale", "sidebarRight", "sidebarRightTabs"];

    /**
     * Register the tab type and its body.
     * @param ctx - the browser half's root context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { en, zh }), "dsh-diff-viewer: dictionaries");
      ctx.effect(
        () =>
          ctx.sidebarRightTabs.register({
            id: VIEWER_ID,
            kind: KIND,
            multiple: true,
            priority: "extension",
            title: () => ctx.locale.bind(NS)("tab.title"),
            guide: [
              {
                id: "open",
                order: 30,
                title: () => ctx.locale.bind(NS)("guide.title"),
                description: () => ctx.locale.bind(NS)("guide.description"),
                icon: GitBranchIcon
              }
            ]
          }),
        "dsh-diff-viewer: tab type"
      );
      ctx.effect(
        () =>
          ctx.slots.inject("sidebar.right.pane.tab", () =>
            ctx.slots.register({ name: "sidebar.right.pane.tab", key: VIEWER_ID, locale: NS }, DiffViewer)
          ),
        "dsh-diff-viewer: tab body"
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
