/**
 * dsh-diff-view — browser half.
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
  id: "dsh-diff-view",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const react = require("react");
    const jsxRuntime = require("react/jsx-runtime");
    const jsx = jsxRuntime.jsx;
    const jsxs = jsxRuntime.jsxs;

    /** Dictionary namespace owned by this plugin. */
    const NS = "dshDiffView";
    /** Tab-type id; also the slot key for the body seat. */
    const VIEW_ID = "dsh-diff-view";
    /** Tab kind discriminator. */
    const KIND = "dsh-diff-view";
    /** Host route the body reads. */
    const ROUTE = "/dsh-diff-view/diff";
    /** Host event stream the body subscribes to for pushed diffs. */
    const EVENTS = "/dsh-diff-view/events";
    /**
     * The fallback read interval.
     *
     * Auto-refresh is push-first: the stream carries a new payload the moment
     * the Host's cheap probe says the working tree moved. If the stream cannot
     * be established at all — a Host too old to serve it, a proxy in the way —
     * the panel falls back to reading the route itself, slowly, and only while
     * the page is visible, rather than going quietly stale.
     */
    const POLL_MS = 20000;
    /** Consecutive stream errors before that fallback takes over. */
    const SSE_ERROR_LIMIT = 3;
    /** `EventSource.CLOSED`: the browser has failed the stream for good. */
    const SSE_CLOSED = 2;
    /**
     * The identity of a payload, ignoring when it was produced.
     *
     * The stream and the initial read can deliver the same diff, and a pushed
     * frame may arrive while the panel already draws it: redrawing a few
     * thousand lines for nothing is exactly the cost this panel avoids.
     *
     * @param payload - a payload from either source.
     * @returns a stable serialization of everything the panel draws.
     */
    const payloadKey = (payload) => {
      try {
        return JSON.stringify(payload, (key, value) => (key === "generatedAt" ? undefined : value));
      } catch {
        return null;
      }
    };
    /** Shortcut command id; namespaced so it cannot collide with a shipped one. */
    const SHORTCUT_ID = "diffView.open";
    /**
     * The mark a file row carries before its name: one glyph per change kind, so
     * the heading stays readable at sidebar width. The precise status still rides
     * on `data-status` for colour and on the row's own name as the tooltip word.
     */
    const STATUS_MARK = {
      added: "+",
      untracked: "+",
      copied: "+",
      deleted: "-",
      modified: "*",
      renamed: "*",
      conflicted: "*"
    };
    /**
     * The three marks, as geometry on a 10x10 grid centred at (5,5).
     *
     * Drawn rather than typed. A text glyph is positioned by the font's baseline
     * and side bearings, not by its own ink, so centring the line box leaves the
     * visible mark off-centre — at 70px the plus sits left and low and the
     * asterisk rides well above the middle, and no single CSS nudge fixes three
     * differently-offset glyphs. Paths put every mark exactly on the centre and
     * make the three the same weight whatever font the page loads.
     */
    const MARK_PATH = {
      "+": "M5 1.4V8.6M1.4 5H8.6",
      "-": "M1.4 5H8.6",
      "*": "M5 1.4V8.6M1.88 3.2L8.12 6.8M1.88 6.8L8.12 3.2"
    };
    /**
     * The disclosure triangle, on the same 10x10 grid.
     *
     * One path for both states — expanded is the same shape turned a quarter
     * turn about the grid centre — so the two cannot drift apart. Drawn for the
     * same reason as the marks, and because the `▸`/`▾` pair it replaced
     * renders as a sliver at any font size small enough to fit the row.
     */
    const CARET_PATH = "M3.2 1.8L7.8 5L3.2 8.2Z";
    /** Beyond this many hunk lines a file starts collapsed. */
    const EXPAND_ALL_LIMIT = 1200;
    /** Hard ceiling on lines rendered for one file. */
    const MAX_RENDERED_LINES = 2500;

    const css = `
/* The panel keeps one fixed type scale. It deliberately does not follow the
   app's font-size preference (--dsh-content-font-size): the diff reads at one
   size however the conversation is set. Change --dsh-diff-code alone to resize
   everything, text and geometry alike.
   --dsh-diff-meta is the chrome's own name for that size: the toolbar, the
   counts, and the notices currently read at it rather than a step under it, so
   it is an alias the panel can move independently later. */
.dsh-diff{--dsh-diff-code:14px;--dsh-diff-meta:var(--dsh-diff-code);--dsh-diff-micro:calc(var(--dsh-diff-code) - 2px);--dsh-diff-strong:calc(var(--dsh-diff-code) + 2px);--dsh-diff-caret:14px;--dsh-diff-mark:14px;--dsh-diff-box:18px;--dsh-diff-gutter:32px;display:flex;flex-direction:column;height:100%;min-height:0;color:var(--dsw-alias-label-primary);font-size:var(--dsh-diff-meta)}
.dsh-diff__bar{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);flex:none;min-width:0}
.dsh-diff__barIcon{flex:none;color:var(--dsw-alias-label-secondary);display:flex}
.dsh-diff__repo{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}
.dsh-diff__branch{font-size:var(--dsh-diff-code);font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-diff__root{font-size:var(--dsh-diff-meta);color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left}
.dsh-diff__action{flex:none;border:.5px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:6px;padding:3px 8px;font:inherit;font-size:var(--dsh-diff-meta);cursor:pointer}
.dsh-diff__action:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.dsh-diff__action:disabled{opacity:.5;cursor:default}
.dsh-diff__counts{display:flex;gap:8px;padding:6px 10px;border-bottom:.5px solid var(--dsw-alias-border-l1);font-size:var(--dsh-diff-meta);color:var(--dsw-alias-label-secondary);flex:none;flex-wrap:wrap}
.dsh-diff__countAdd{color:var(--dsw-alias-state-success-primary)}
.dsh-diff__countDel{color:var(--dsw-alias-state-error-primary)}
.dsh-diff__scroll{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain}
.dsh-diff__notice{margin:8px 10px;padding:8px 10px;border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:var(--dsh-diff-meta);line-height:1.5}
.dsh-diff__empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;height:100%;padding:24px;text-align:center;color:var(--dsw-alias-label-secondary)}
.dsh-diff__emptyIcon{color:var(--dsw-alias-label-secondary);opacity:.8}
.dsh-diff__emptyTitle{font-size:var(--dsh-diff-strong);font-weight:600;color:var(--dsw-alias-label-primary)}
.dsh-diff__emptyBody{font-size:var(--dsh-diff-code);line-height:1.6;max-width:34ch}
.dsh-diff__emptyPath{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:var(--dsh-diff-meta);word-break:break-all;color:var(--dsw-alias-label-secondary)}
.dsh-diff__file{border-bottom:.5px solid var(--dsw-alias-border-l1)}
.dsh-diff__fileHead{display:flex;align-items:center;gap:6px;width:100%;padding:6px 10px;background:var(--dsw-alias-bg-layer-1);border:0;font:inherit;color:inherit;text-align:left;cursor:pointer;min-width:0}
.dsh-diff__fileHead:hover{background:var(--dsw-alias-bg-layer-2)}
.dsh-diff__caret{flex:none;display:block;width:var(--dsh-diff-caret);height:var(--dsh-diff-caret);color:var(--dsw-alias-label-secondary)}
.dsh-diff__badge{flex:none;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;width:var(--dsh-diff-box);height:var(--dsh-diff-box);border-radius:4px;border:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
.dsh-diff__badge[data-mark="+"]{color:var(--dsw-alias-state-success-primary)}
.dsh-diff__badge[data-mark="-"]{color:var(--dsw-alias-state-error-primary)}
.dsh-diff__badge[data-mark="*"]{color:var(--dsw-alias-state-warn-primary)}
.dsh-diff__badge svg{display:block;width:var(--dsh-diff-mark);height:var(--dsh-diff-mark)}
.dsh-diff__badge[data-status=untracked]{border-style:dashed}
.dsh-diff__path{flex:1;min-width:0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:var(--dsh-diff-code);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left}
.dsh-diff__stat{flex:none;display:flex;gap:5px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:var(--dsh-diff-code)}
.dsh-diff__statAdd{color:var(--dsw-alias-state-success-primary)}
.dsh-diff__statDel{color:var(--dsw-alias-state-error-primary)}
.dsh-diff__chip{flex:none;font-size:var(--dsh-diff-micro);color:var(--dsw-alias-label-secondary);border:.5px solid var(--dsw-alias-border-l1);border-radius:4px;padding:1px 4px}
.dsh-diff__hunk{border-top:.5px solid var(--dsw-alias-border-l1)}
.dsh-diff__hunkHead{box-sizing:border-box;padding:3px 10px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:var(--dsh-diff-code);color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);white-space:pre-wrap;overflow-wrap:anywhere}
/* One line mirrors the built-in review diff's own line: two number columns, a
   sign, then the text, laid out on one grid so the columns line up down a hunk,
   and a changed line wears the same file-diff fills plus a 3px marker down its
   leading edge. */
.dsh-diff__line{display:grid;grid-template-columns:calc(var(--dsh-diff-gutter) + 10px) var(--dsh-diff-gutter) 11px minmax(0,1fr);box-sizing:border-box;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:var(--dsh-diff-code);line-height:1.55;white-space:pre-wrap;overflow-wrap:anywhere}
.dsh-diff__no{box-sizing:border-box;padding:0 5px 0 0;text-align:right;color:var(--dsw-alias-label-tertiary);user-select:none}
.dsh-diff__no[data-side=old]{padding-left:10px}
.dsh-diff__sign{box-sizing:border-box;text-align:center;color:var(--dsw-alias-label-tertiary);user-select:none}
.dsh-diff__code{box-sizing:border-box;padding-right:10px;min-width:0}
.dsh-diff__line--add{--dsh-diff-fill:var(--dsw-alias-file-diff-added-gutter,var(--dsw-alias-code-diff-added));--dsh-diff-marker:var(--dsw-alias-file-diff-added-marker,var(--dsw-alias-state-success-primary));background:var(--dsw-alias-file-diff-added-bg,var(--dsw-alias-code-diff-added))}
.dsh-diff__line--delete{--dsh-diff-fill:var(--dsw-alias-file-diff-deleted-gutter,var(--dsw-alias-code-diff-deleted));--dsh-diff-marker:var(--dsw-alias-file-diff-deleted-marker,var(--dsw-alias-state-error-primary));background:var(--dsw-alias-file-diff-deleted-bg,var(--dsw-alias-code-diff-deleted))}
.dsh-diff__line--add .dsh-diff__no,.dsh-diff__line--delete .dsh-diff__no{background:var(--dsh-diff-fill);color:var(--dsh-diff-marker)}
.dsh-diff__line--add .dsh-diff__no[data-side=old],.dsh-diff__line--delete .dsh-diff__no[data-side=old]{box-shadow:inset 3px 0 0 var(--dsh-diff-marker)}
.dsh-diff__line--add .dsh-diff__sign,.dsh-diff__line--delete .dsh-diff__sign{color:var(--dsh-diff-marker)}
.dsh-diff__line--meta{color:var(--dsw-alias-label-secondary);font-style:italic}
.dsh-diff__spinner{width:13px;height:13px;border:1.5px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-label-secondary);border-radius:50%;animation:dsh-diff-spin .8s linear infinite}
@keyframes dsh-diff-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.dsh-diff__spinner{animation-duration:2.4s}}
`;

    /**
     * Install or refresh this plugin's stylesheet.
     *
     * The page keeps one style tag per `data-plugin-css` id, and a client bundle
     * hot-reload re-runs this factory in place while the previous tag survives.
     * Creating the tag only when it is absent would therefore pin whichever
     * stylesheet the first load happened to carry, and every later edit would
     * apply to nothing until a full page refresh. So an existing tag is updated
     * in place, and the write is skipped when the text already matches.
     */
    const CSS_ID = "dsh-diff-view/view.css";
    if (typeof document !== "undefined") {
      const installed = document.querySelector(`style[data-plugin-css=${JSON.stringify(CSS_ID)}]`);
      const tag = installed ?? document.createElement("style");
      tag.dataset.plugin = VIEW_ID;
      tag.dataset.pluginCss = CSS_ID;
      if (tag.textContent !== css) tag.textContent = css;
      if (installed === null) document.head.appendChild(tag);
    }

    const en = {
      /* One name for both seats: the tab chip and the guide entry. */
      name: "Diff View",
      "guide.description": "Review the working tree's changes",
      loading: "Reading git diff…",
      refresh: "Refresh",
      "branch.detached": "detached HEAD",
      "branch.unborn": "no commits yet",
      "counts.files": "{count} files",
      "counts.untracked": "{count} untracked",
      clean: "The working tree has no changes.",
      "noGit.title": "Not a git project",
      "noGit.body": "This project has no .git directory, so there is no git diff to show.",
      "noGit.hint": "Initialize a repository with git init to start tracking changes.",
      "error.title": "Could not read the git diff",
      retry: "Retry",
      "note.binary": "Binary file — no textual diff",
      "note.empty": "No line changes (a metadata-only change).",
      "note.empty-file": "This file is empty.",
      "note.large": "This file is larger than the preview limit.",
      "note.unreadable": "Could not read this file.",
      "note.omitted": "Content not loaded — the untracked set is too large to preview.",
      "shortcut.noSession": "Open a session first.",
      "truncated": "The diff exceeded the collection limit; the tail is missing.",
      "hidden.lines": "… {count} more lines are not rendered",
      "directory": "Directory",
      "status.modified": "Modified",
      "status.added": "Added",
      "status.deleted": "Deleted",
      "status.renamed": "Renamed",
      "status.copied": "Copied",
      "status.conflicted": "Conflicted",
      "status.untracked": "Untracked"
    };

    const zh = {
      name: "Diff 视图",
      "guide.description": "查看工作区的改动",
      loading: "正在读取 git diff…",
      refresh: "刷新",
      "branch.detached": "游离 HEAD",
      "branch.unborn": "尚无提交",
      "counts.files": "{count} 个文件",
      "counts.untracked": "{count} 个未跟踪",
      clean: "工作区没有改动。",
      "noGit.title": "非 Git 项目",
      "noGit.body": "该项目下没有 .git 目录，无法显示 git diff。",
      "noGit.hint": "可以用 git init 初始化仓库后再查看。",
      "error.title": "无法读取 git diff",
      retry: "重试",
      "note.binary": "二进制文件，没有文本差异",
      "note.empty": "没有行改动（仅元数据变化）。",
      "note.empty-file": "空文件。",
      "note.large": "文件超出预览大小上限。",
      "note.unreadable": "无法读取该文件。",
      "note.omitted": "未加载内容——未跟踪的文件太多，超出预览预算。",
      "shortcut.noSession": "请先打开一个会话。",
      "truncated": "差异超出收集上限，末尾内容已缺失。",
      "hidden.lines": "… 还有 {count} 行未渲染",
      "directory": "目录",
      "status.modified": "已修改",
      "status.added": "新增",
      "status.deleted": "已删除",
      "status.renamed": "已重命名",
      "status.copied": "已复制",
      "status.conflicted": "冲突",
      "status.untracked": "未跟踪"
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
     * One file's change mark, drawn.
     * @param props - the `+`, `-`, or `*` to draw.
     * @returns a decorative SVG; the row's own name carries the word.
     */
    function Mark({ mark }) {
      return jsx("svg", {
        width: 11,
        height: 11,
        viewBox: "0 0 10 10",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 1.25,
        strokeLinecap: "round",
        "aria-hidden": "true",
        children: jsx("path", { d: MARK_PATH[mark] })
      });
    }

    /**
     * The row's disclosure triangle.
     * @param props - whether the row is open.
     * @returns a decorative SVG; the row button already reports `aria-expanded`.
     */
    function Caret({ open }) {
      return jsx("svg", {
        className: "dsh-diff__caret",
        width: 12,
        height: 12,
        viewBox: "0 0 10 10",
        "aria-hidden": "true",
        children: jsx("path", {
          d: CARET_PATH,
          fill: "currentColor",
          transform: open ? "rotate(90 5 5)" : undefined
        })
      });
    }

    /**
     * The line-number gutter.
     *
     * Two columns, as the built-in review diff draws them: the old-side number
     * first, then the new-side one, each in its own grid track so the numbers
     * line up down a hunk. A deletion fills only the old column (the new one
     * stays blank) and an addition only the new one, which is exactly what
     * tells a reader at a glance which side of the change a line belongs to.
     * The left column also carries the changed line's 3px marker, so the
     * highlight starts at the panel edge rather than at the first digit.
     *
     * Both numbers come from the Host — `line.oldLine` and `line.newLine` — so
     * this only prints the fields it is handed: neither side is re-derived in
     * the browser, and the Host's own tests cover when each side has a number.
     *
     * @param props - the hunk line whose two numbers to show.
     * @returns the gutter's cells.
     */
    function Gutter({ line }) {
      /**
       * Print one side's number, or an empty cell when the side has none.
       * @param side - the `data-side` marker: `old` or `new`.
       * @param value - that side's number, or null.
       * @returns the gutter cell.
       */
      const cell = (side, value) =>
        jsx(
          "span",
          {
            className: "dsh-diff__no",
            "data-side": side,
            children: value === undefined || value === null ? "" : String(value)
          },
          side
        );
      return jsxs(react.Fragment, {
        children: [cell("old", line.oldLine), cell("new", line.newLine)]
      });
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
                  jsx(Gutter, { line }),
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
     *
     * A file is either rendered as hunks or explained by its `note`: a binary
     * file, one past the preview cap, one the Host could not read, or one the
     * untracked budget skipped. A tracked file with no hunks at all is a
     * metadata-only change, which is neither of those.
     *
     * @param props - the file, its open state, the toggle, and the active translator.
     * @returns the section.
     */
    function FileBlock({ file, open, onToggle, t }) {
      const label = t(`status.${file.status}`);
      const mark = STATUS_MARK[file.status] ?? "*";
      const noteKey = file.note === null || file.note === undefined ? "note.empty" : `note.${file.note}`;
      /* Untracked already says the change is unstaged, so the chips stay off it. */
      const tracked = file.status !== "untracked";
      const heading = jsxs("button", {
        type: "button",
        className: "dsh-diff__fileHead",
        "aria-expanded": open,
        /* The mark is one glyph, so the row's own name carries the word. */
        "aria-label": `${label} ${file.path}`,
        onClick: onToggle,
        children: [
          jsx(Caret, { open }),
          jsx("span", { className: "dsh-diff__badge", "data-status": file.status, "data-mark": mark, title: label, children: jsx(Mark, { mark }) }),
          jsx("span", { className: "dsh-diff__path", title: file.path, children: file.path }),
          file.previousPath === null || file.previousPath === undefined
            ? null
            : jsx("span", { className: "dsh-diff__chip", title: file.previousPath, children: "\u2190" }),
          file.staged && file.unstaged ? jsx("span", { className: "dsh-diff__chip", children: "staged+wt" }) : null,
          tracked && !file.staged && file.unstaged ? jsx("span", { className: "dsh-diff__chip", children: "wt" }) : null,
          file.note !== null && file.note !== undefined
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
        body =
          file.hunks.length === 0
            ? jsx("div", { className: "dsh-diff__notice", children: t(noteKey) })
            : jsx(Hunks, { file, t });
      }
      return jsxs("section", { className: "dsh-diff__file", children: [heading, body] });
    }

    /**
     * The tab body: read the Host route, then follow its event stream.
     *
     * The read draws the panel; the stream keeps it current. Both funnel into
     * one commit path that drops a payload the panel already draws, so a frame
     * that says nothing new costs a string compare rather than a redraw.
     *
     * @param props - the session-scoped slot props (`sessionId` and `t`).
     * @returns the diff panel.
     */
    function DiffView(props) {
      const sessionId = props.sessionId;
      const t = props.t;
      const [nonce, setNonce] = react.useState(0);
      const [state, setState] = react.useState({ phase: "loading" });
      const [openMap, setOpenMap] = react.useState({});
      /** The identity of the payload on screen; null until one is drawn. */
      const drawn = react.useRef(null);

      /* A different session is a different diff: nothing drawn belongs to it. */
      react.useEffect(() => {
        drawn.current = null;
      }, [sessionId]);

      /**
       * Put one payload on screen unless it is the one already there.
       * @param payload - a payload from the route or from the stream.
       */
      const commit = (payload) => {
        if (payload === null || typeof payload !== "object") return;
        const key = payloadKey(payload);
        if (key !== null && key === drawn.current) return;
        drawn.current = key;
        setState({ phase: "ready", payload });
      };

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
            if (!lifetime.signal.aborted) commit(payload);
          })
          .catch((error) => {
            if (lifetime.signal.aborted) return;
            /* A failed read clears the drawn key: whatever arrives next is news. */
            drawn.current = null;
            setState({ phase: "error", message: error instanceof Error ? error.message : String(error) });
          });
        return () => lifetime.abort();
      }, [sessionId, nonce]);

      react.useEffect(() => {
        let source = null;
        let timer = null;
        let errors = 0;
        let live = true;

        /** Whether the page is on screen; a hidden page is not worth refreshing. */
        const onScreen = () => typeof document === "undefined" || document.visibilityState === "visible";
        const dropStream = () => {
          if (source === null) return;
          source.close();
          source = null;
        };
        const readAgain = () => {
          setNonce((value) => value + 1);
        };
        const startPolling = () => {
          if (timer !== null || !live) return;
          timer = setInterval(() => {
            if (onScreen()) readAgain();
          }, POLL_MS);
        };
        const openStream = () => {
          if (!live || source !== null || typeof EventSource !== "function" || !onScreen()) return;
          const stream = new EventSource(`${EVENTS}?sessionId=${encodeURIComponent(String(sessionId ?? ""))}`);
          source = stream;
          stream.addEventListener("diff", (event) => {
            errors = 0;
            try {
              commit(JSON.parse(String(event.data)));
            } catch {
              /* A frame we cannot read is a frame that changed nothing. */
            }
          });
          stream.addEventListener("changed", readAgain);
          stream.addEventListener("error", () => {
            errors += 1;
            /* A stream the browser has failed for good — a Host that does not
               serve it at all, a proxy in the way — never fires again, so the
               poll takes over at once. Anything else is the reconnect the
               browser is already doing, and a few of those are not a verdict. */
            if (stream.readyState !== SSE_CLOSED && errors < SSE_ERROR_LIMIT) return;
            dropStream();
            startPolling();
          });
        };
        const onVisibility = () => {
          if (!onScreen()) {
            dropStream();
            return;
          }
          openStream();
          /* Nothing pushes while the fallback poll owns the refresh, so coming
             back to the page is what re-reads the diff there. */
          if (timer !== null) readAgain();
        };

        if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibility);
        if (typeof EventSource === "function") openStream();
        else startPolling();
        return () => {
          live = false;
          dropStream();
          if (timer !== null) clearInterval(timer);
          if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility);
        };
      }, [sessionId]);

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

      return jsxs("div", {
        className: "dsh-diff",
        children: [bar, summary, jsx("div", { className: "dsh-diff__scroll", children: body })]
      });
    }

    /** Services this client plugin consumes. */
    const inject = ["slots", "locale", "sidebarRight", "sidebarRightTabs", "shortcuts"];

    /**
     * Register the tab type, its body, and the open shortcut.
     * @param ctx - the browser half's root context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { en, zh }), "dsh-diff-view: dictionaries");
      ctx.effect(
        () =>
          ctx.sidebarRightTabs.register({
            id: VIEW_ID,
            kind: KIND,
            /**
             * Not a multi-instance type. A multi-instance address is minted fresh
             * per open (`<page>/<uuid>`), so every open would add another tab; a
             * single address lets the owner's own `revealIfOpened` path find the
             * open tab and focus it instead, which is what both the guide entry
             * and the shortcut rely on.
             */
            multiple: false,
            priority: "extension",
            title: () => ctx.locale.bind(NS)("name"),
            guide: [
              {
                id: "open",
                order: 30,
                /*
                 * Naming the command is what puts the keycaps on the entry: the
                 * column's own capsule looks this id up in the shortcut catalog
                 * and draws whatever it resolves to for the running platform,
                 * and sets the same keys as the button's `aria-keyshortcuts`. An
                 * id matching no command loses the hint silently, so the client
                 * check ties the two together.
                 */
                commandId: SHORTCUT_ID,
                title: () => ctx.locale.bind(NS)("name"),
                description: () => ctx.locale.bind(NS)("guide.description"),
                icon: GitBranchIcon
              }
            ]
          }),
        "dsh-diff-view: tab type"
      );
      ctx.effect(
        () =>
          ctx.slots.inject("sidebar.right.pane.tab", () =>
            ctx.slots.register({ name: "sidebar.right.pane.tab", key: VIEW_ID, locale: NS }, DiffView)
          ),
        "dsh-diff-view: tab body"
      );
      ctx.effect(
        () =>
          ctx.shortcuts.register({
            id: SHORTCUT_ID,
            label: () => ctx.locale.bind(NS)("name"),
            aliases: ["diff", "git diff", "changes"],
            /**
             * Desktop profiles only, and deliberately so: `shortcuts` validates
             * every runtime/platform pair on registration, and a single primary
             * modifier is not an admitted Web binding — a browser owns Cmd/Ctrl+D
             * as bookmark. Declaring one would throw `Unsupported Web shortcut`
             * and take the whole plugin down.
             */
            defaults: {
              "desktop:macos": { code: "KeyD", modifiers: ["primary"] },
              "desktop:windows": { code: "KeyD", modifiers: ["primary"] },
              "desktop:linux": { code: "KeyD", modifiers: ["primary"] }
            },
            regions: ["page", "editable"],
            modals: [],
            resolve: ({ target: element }) => {
              const target = ctx.sidebarRight.commandTarget(element);
              /* Falls back to the mounted session, so the key works from the composer too. */
              if (target === undefined) return { status: "blocked", reason: ctx.locale.bind(NS)("shortcut.noSession") };
              return {
                status: "handled",
                run: () => {
                  ctx.sidebarRight.openTabFromTarget(KIND, target);
                }
              };
            }
          }),
        "dsh-diff-view: shortcut"
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    /**
     * Test seam. The presentational pieces are pure functions of their props, so
     * `test/client.mjs` renders them through a stub module loader without React
     * and asserts what the browser would actually draw — most importantly that a
     * hunk line's two numbers reach the gutter. A field-name mismatch between
     * the halves is invisible to the Host's own tests, which is how the gutter
     * once rendered empty on every line.
     */
    exports.__internals = { Caret, Gutter, Hunks, FileBlock, Mark, DiffView, payloadKey };
    return module.exports;
  }
});
