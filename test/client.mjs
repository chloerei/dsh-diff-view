/**
 * Tests for the browser half.
 *
 * The bundle is a `window.__ModuleLoader__.load({ id, factory })` file, so this
 * loads it through a stub module loader and a stub `require`, then renders the
 * presentational pieces the bundle exposes as a test seam. No React and no DOM
 * are involved: `react/jsx-runtime` is stubbed to plain objects that record what
 * would have been drawn.
 *
 * This is the coverage the Host's tests cannot provide. A host/client field-name
 * mismatch leaves the Host payload perfectly correct while the panel renders
 * blank — which is exactly what happened to the line-number gutter.
 *
 * Run with `node test/client.mjs` from the package root.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { hunksFromText, parseUnifiedPatch } from "../lib/git-diff.js";

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
 * The `react/jsx-runtime` shape the bundle uses, recording instead of drawing.
 * @param type - the element type.
 * @param props - the element props, children included.
 * @param key - the reconciliation key.
 * @returns a plain description of the element.
 */
function element(type, props, key) {
  return { type, props: props ?? {}, key };
}

/** Minimal `react` surface; every component under test here is hook-free. */
const reactStub = {
  createElement: element,
  Fragment: "Fragment",
  Suspense: "Suspense",
  useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
  useEffect: () => {},
  useLayoutEffect: () => {},
  useRef: (value) => ({ current: value }),
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
};

/**
 * The page's style tag, shared across loads exactly as the real page shares it,
 * plus how many tags were ever appended.
 */
const styles = { tag: null, appends: 0 };

/**
 * Load the bundle the way the Harness page does.
 * @returns the bundle's exports.
 */
function loadBundle() {
  const window = { __ModuleLoader__: { load: (value) => (registration = value) } };
  let registration;
  const document = {
    querySelector: () => styles.tag,
    createElement: () => ({ dataset: {}, textContent: "" }),
    head: {
      appendChild: (tag) => {
        styles.tag = tag;
        styles.appends += 1;
      }
    }
  };
  const require = (specifier) => {
    if (specifier === "react") return reactStub;
    if (specifier === "react/jsx-runtime") return { jsx: element, jsxs: element, Fragment: "Fragment" };
    throw new Error(`unexpected require(${JSON.stringify(specifier)})`);
  };
  /* The bundle is a classic script, not a module, so it runs under new Function. */
  new Function("window", "document", source)(window, document);
  assert.ok(registration !== undefined, "the bundle never registered itself");
  assert.equal(registration.id, "dsh-diff-viewer", "the module id must equal the package name");
  return registration.factory(require);
}

/**
 * Render a component tree, resolving function components as React would.
 * @param node - the tree to walk.
 * @param visitElement - called for every host element.
 * @param visitText - called for every text leaf.
 */
function walk(node, visitElement, visitText) {
  if (node === null || node === undefined || typeof node === "boolean") return;
  if (typeof node === "string" || typeof node === "number") {
    visitText?.(String(node));
    return;
  }
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visitElement, visitText);
    return;
  }
  if (typeof node !== "object") return;
  if (typeof node.type === "function") {
    walk(node.type(node.props), visitElement, visitText);
    return;
  }
  visitElement?.(node);
  walk(node.props.children, visitElement, visitText);
}

/**
 * Render one component and collect its elements and text.
 * @param component - the function component.
 * @param props - its props.
 * @returns the collected elements and text leaves.
 */
function render(component, props) {
  const elements = [];
  const text = [];
  walk(component(props), (node) => elements.push(node), (value) => text.push(value));
  return { elements, text };
}

/**
 * Select the rendered elements carrying one class.
 * @param result - a {@link render} result.
 * @param className - the class to match.
 * @returns the matching elements.
 */
function byClass(result, className) {
  return result.elements.filter(
    (node) => typeof node.props.className === "string" && node.props.className.split(" ").includes(className)
  );
}

const here = dirname(fileURLToPath(import.meta.url));
const source = await readFile(join(here, "..", "lib", "client.js"), "utf8");
const bundle = loadBundle();
const { Caret, Gutter, Hunks, FileBlock, Mark } = bundle.__internals;

/**
 * The mark geometry the bundle draws, mirrored here so the assertions name the
 * shapes rather than reading them back out of the code under test.
 */
const MARK_PATH = {
  "+": "M5 1.4V8.6M1.4 5H8.6",
  "-": "M1.4 5H8.6",
  "*": "M5 1.4V8.6M1.88 3.2L8.12 6.8M1.88 6.8L8.12 3.2"
};

/** A file record shaped exactly as the Host emits one. */
const trackedFile = {
  path: "f.txt",
  previousPath: null,
  status: "modified",
  staged: false,
  unstaged: true,
  conflicted: false,
  binary: false,
  note: null,
  additions: 2,
  deletions: 1,
  hunks: [
    {
      header: "@@ -1,3 +1,3 @@",
      lines: [
        { kind: "context", text: "keep", oldLine: 1, newLine: 1, number: 1 },
        { kind: "delete", text: "old", oldLine: 2, newLine: null, number: 2 },
        { kind: "add", text: "new", oldLine: null, newLine: 2, number: 2 }
      ]
    }
  ]
};

console.log("client bundle");

await check("the factory exposes apply, inject, and the test seam", () => {
  assert.equal(typeof bundle.apply, "function");
  assert.deepEqual(bundle.inject, ["slots", "locale", "sidebarRight", "sidebarRightTabs", "shortcuts"]);
  assert.equal(typeof Gutter, "function");
  assert.equal(typeof Hunks, "function");
  assert.equal(typeof FileBlock, "function");
  assert.equal(typeof Mark, "function");
  assert.equal(typeof Caret, "function");
});

const installedCss = () => styles.tag?.textContent ?? "";

await check("the stylesheet is installed once, tagged with the package", () => {
  assert.equal(styles.appends, 1, "the bundle did not install exactly one stylesheet");
  assert.ok(installedCss().length > 0, "the installed stylesheet is empty");
  assert.equal(styles.tag.dataset.plugin, "dsh-diff-viewer", "the stylesheet is not tagged with the package");
});

await check("a hot reload refreshes the existing stylesheet instead of pinning the first one", () => {
  /* The bug this guards: the factory re-runs on a client hot reload while the
     previous style tag survives, so creating the tag only when absent pinned
     whichever CSS the first load carried and every later edit applied to
     nothing until a full page refresh. */
  styles.tag.textContent = "/* the stylesheet from an earlier load */";
  loadBundle();
  assert.equal(styles.appends, 1, "the reload appended a second style tag");
  assert.ok(installedCss().includes(".dsh-diff__badge"), "the stale stylesheet was not replaced");
  assert.notEqual(installedCss(), "/* the stylesheet from an earlier load */");
});

/**
 * Read one rule's declarations out of the installed stylesheet.
 * @param selector - the exact selector, including any attribute part.
 * @returns the declarations between its braces.
 */
function rule(selector) {
  const pattern = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\{([^}]*)\\}`);
  const match = pattern.exec(installedCss());
  assert.ok(match !== null, `no CSS rule for ${selector}`);
  return match[1];
}

await check("long diff lines wrap instead of overflowing the panel", () => {
  const line = rule(".dsh-diff__line");
  assert.ok(line.includes("white-space:pre-wrap"), `.dsh-diff__line must wrap, got: ${line}`);
  assert.ok(line.includes("overflow-wrap:anywhere"), `.dsh-diff__line must break unbroken tokens, got: ${line}`);
  /* The hunk header used to be the other sideways-scrolling surface. */
  assert.ok(!rule(".dsh-diff__hunkHead").includes("overflow-x:auto"), "the hunk header can still scroll sideways");
  assert.ok(!installedCss().includes("overflow-x:auto"), "a horizontal scroll surface remains");
});

await check("the diff body is inset from the panel edges", () => {
  assert.match(rule(".dsh-diff__line"), /padding-left:\s*\d/, "diff lines are flush against the left edge");
  assert.match(rule(".dsh-diff__code"), /padding-right:\s*\d/, "diff lines are flush against the right edge");
  assert.match(rule(".dsh-diff__hunkHead"), /padding:\s*\S+\s+\S+/, "the hunk header lost its inset");
});

/** Everything one `apply` call registered. */
const calls = { locale: [], tabs: [], slots: [], shortcuts: [] };

/**
 * Build a context that records what the bundle registers.
 * @param overrides - per-test replacements, merged one level deep.
 * @returns the stub context.
 */
function recordingContext(overrides = {}) {
  const sink = overrides.sink ?? calls;
  return {
    effect: (fn) => fn(),
    locale: {
      register: (ns, dicts) => sink.locale.push({ ns, dicts }),
      bind: () => (key) => key
    },
    sidebarRightTabs: { register: (definition) => sink.tabs.push(definition) },
    shortcuts: { register: (command) => sink.shortcuts.push(command) },
    sidebarRight: {
      commandTarget: () => ({ sessionId: "s", paneId: "p", host: "dock", tabId: undefined }),
      openTabFromTarget: () => {}
    },
    slots: {
      inject: (slot) => {
        sink.slots.push(slot);
        return () => {};
      },
      register: (options, component) => ({ options, component })
    },
    ...overrides
  };
}

/** A fresh recorder for the tests that need their own. */
const freshCalls = () => ({ locale: [], tabs: [], slots: [], shortcuts: [] });

await check("apply registers the dictionary, the tab type, and the tab body", () => {
  bundle.apply(recordingContext());

  assert.deepEqual(calls.locale.map((entry) => entry.ns), ["dshDiffViewer"]);
  /* Both languages must carry the name; one key means the tab chip and the
     guide entry cannot drift apart. */
  const { en, zh } = calls.locale[0].dicts;
  assert.equal(en.name, "Diff Viewer", "the English name changed");
  assert.equal(zh.name, "Diff 查看器", "the Chinese name changed");

  assert.equal(calls.tabs.length, 1);
  const type = calls.tabs[0];
  assert.equal(type.id, "dsh-diff-viewer");
  assert.equal(type.kind, "dsh-diff-viewer");
  /* Not multi-instance: a fresh address per open is what adds a second tab. */
  assert.equal(type.multiple, false, "a multi-instance type opens a new tab every time");
  /* The tab chip and the guide entry draw the same name, from the same key. */
  assert.deepEqual(type.guide.map((entry) => entry.id), ["open"]);
  /* The column draws keycaps from this id, so it has to name the command. */
  assert.equal(type.guide[0].commandId, calls.shortcuts[0].id, "the guide entry names a command that is not registered");
  assert.equal(type.title(), "name", "the tab chip names itself from its own key");
  assert.equal(type.guide[0].title(), "name", "the guide entry names itself separately from the tab");
  assert.equal(typeof type.guide[0].description(), "string");
  assert.ok(calls.slots.includes("sidebar.right.pane.tab"), "the tab body slot was not injected");

  assert.equal(calls.shortcuts.length, 1, "the open shortcut was not registered");
  const command = calls.shortcuts[0];
  assert.equal(command.id, "diffViewer.open");
  /* Cmd/Ctrl+D on the desktop profiles the user actually runs. */
  assert.deepEqual(command.defaults["desktop:macos"], { code: "KeyD", modifiers: ["primary"] });
  assert.ok(command.regions.includes("page"), "the shortcut does not fire on the page");
  /* The three draws the same key, so one name and one label for both seats. */
  assert.equal(command.label(), "name");
});

await check("the command the guide entry names has a binding to draw", () => {
  /* The column resolves `commandId` against the shortcut catalog and draws
     whatever comes back, so the hint exists only while the entry names a
     registered command that carries keys for the running platform. */
  const live = freshCalls();
  bundle.apply(recordingContext({ sink: live }));
  const entry = live.tabs[0].guide[0];
  const command = live.shortcuts.find((row) => row.id === entry.commandId);
  assert.ok(command !== undefined, `no command answers the guide entry's commandId (${entry.commandId})`);
  const desktop = Object.entries(command.defaults).filter(([profile]) => profile.startsWith("desktop:"));
  assert.ok(desktop.length > 0, "the command has no desktop binding, so the capsule would draw no hint");
  for (const [profile, binding] of desktop) {
    assert.equal(binding.code, "KeyD", `${profile} is not bound to the D key`);
    assert.deepEqual(binding.modifiers, ["primary"], `${profile} is not bound to the platform modifier`);
  }
});

await check("the shortcut declares no Web binding, which the registry would reject", () => {
  /* `shortcuts.register` validates every runtime/platform pair, and a browser
     owns Cmd/Ctrl+D as bookmark: `isWebBindingAllowed` admits a single primary
     modifier only for Comma and Backslash. A declared Web default would throw
     `Unsupported Web shortcut` and take the whole plugin down with it. */
  const command = calls.shortcuts[0];
  for (const key of Object.keys(command.defaults)) {
    assert.ok(key.startsWith("desktop:"), `a Web default would be rejected at registration: ${key}`);
  }
  assert.equal(command.defaults["web:macos"], undefined);
});

await check("the shortcut resolves a session, and blocks when there is none", () => {
  const opened = [];
  const live = freshCalls();
  bundle.apply(
    recordingContext({
      sink: live,
      sidebarRight: {
        commandTarget: () => ({ sessionId: "s1", paneId: "p1", host: "dock", tabId: undefined }),
        openTabFromTarget: (kind, target) => opened.push([kind, target.sessionId])
      }
    })
  );
  const resolved = live.shortcuts[0].resolve({ target: undefined });
  assert.equal(resolved.status, "handled", "a resolvable target was not handled");
  resolved.run();
  assert.deepEqual(opened, [["dsh-diff-viewer", "s1"]], "the shortcut opened the wrong kind or session");

  /* Without a mounted session the command must refuse, not throw. */
  const barren = freshCalls();
  bundle.apply(
    recordingContext({
      sink: barren,
      sidebarRight: { commandTarget: () => undefined, openTabFromTarget: () => {} }
    })
  );
  const blocked = barren.shortcuts[0].resolve({ target: undefined });
  assert.equal(blocked.status, "blocked", "a missing session was not reported");
  assert.equal(blocked.reason, "shortcut.noSession");
});

await check("a hunk line's number reaches the gutter", () => {
  /* The bug this guards: the gutter once read `line.old`/`line.new` while the
     Host sent `oldLine`/`newLine`, so every gutter drew an empty string. */
  const cases = [
    { line: { kind: "context", text: "same", oldLine: 4, newLine: 4, number: 4 }, side: "new", text: "4" },
    { line: { kind: "add", text: "added", oldLine: null, newLine: 5, number: 5 }, side: "new", text: "5" },
    { line: { kind: "delete", text: "gone", oldLine: 6, newLine: null, number: 6 }, side: "old", text: "6" },
    { line: { kind: "meta", text: "No newline at end of file", oldLine: null, newLine: null, number: null }, side: "new", text: "" }
  ];
  for (const testCase of cases) {
    const [gutter] = byClass(render(Gutter, { line: testCase.line }), "dsh-diff__no");
    assert.ok(gutter !== undefined, `no gutter drawn for a ${testCase.line.kind} line`);
    assert.equal(gutter.props["data-side"], testCase.side, `wrong side for a ${testCase.line.kind} line`);
    assert.equal(gutter.props.children, testCase.text, `wrong number for a ${testCase.line.kind} line`);
  }
});

await check("the Host numbers a deletion from the old side and the rest from the new", () => {
  const patch = [
    "diff --git a/f.txt b/f.txt",
    "--- a/f.txt",
    "+++ b/f.txt",
    "@@ -1,3 +1,3 @@",
    " keep",
    "-old",
    "+new",
    " tail"
  ].join("\n");
  const lines = parseUnifiedPatch(patch).get("f.txt").hunks[0].lines;
  assert.deepEqual(
    lines.map((entry) => [entry.kind, entry.number]),
    [
      ["context", 1],
      ["delete", 2],
      ["add", 2],
      ["context", 3]
    ]
  );
});

await check("a rendered hunk shows one number per line, the sign, and the text", () => {
  const result = render(Hunks, { file: trackedFile, t: (key) => key });
  assert.deepEqual(byClass(result, "dsh-diff__no").map((node) => node.props.children), ["1", "2", "2"]);
  assert.deepEqual(byClass(result, "dsh-diff__sign").map((node) => node.props.children), [" ", "-", "+"]);
  const flat = result.text.join("");
  assert.ok(flat.includes("keep") && flat.includes("old") && flat.includes("new"), "line text is missing");
  assert.ok(flat.includes("@@ -1,3 +1,3 @@"), "the hunk header is missing");
  assert.ok(byClass(result, "dsh-diff__line--delete").length === 1, "the deletion lost its row tint");
  assert.ok(byClass(result, "dsh-diff__line--add").length === 1, "the addition lost its row tint");
});

await check("an untracked file draws as numbered additions", () => {
  const hunks = hunksFromText("alpha\nbeta\n");
  const file = { ...trackedFile, path: "fresh.txt", status: "untracked", additions: 2, deletions: 0, hunks };
  const result = render(Hunks, { file, t: (key) => key });
  assert.deepEqual(byClass(result, "dsh-diff__no").map((node) => node.props.children), ["1", "2"]);
  assert.deepEqual(byClass(result, "dsh-diff__sign").map((node) => node.props.children), ["+", "+"]);
  const flat = result.text.join("");
  assert.ok(flat.includes("alpha") && flat.includes("beta"), "untracked contents are missing");
  assert.ok(flat.includes("@@ -0,0 +1,2 @@"), "the new-file hunk header is missing");
});

await check("a collapsed file block draws its heading but no hunk", () => {
  const closed = render(FileBlock, { file: trackedFile, open: false, onToggle: () => {}, t: (key) => key });
  assert.equal(byClass(closed, "dsh-diff__hunk").length, 0, "a collapsed file drew its hunk");
  assert.equal(byClass(closed, "dsh-diff__line").length, 0, "a collapsed file drew its lines");
  const [head] = byClass(closed, "dsh-diff__fileHead");
  assert.equal(head.props["aria-expanded"], false);
  assert.ok(closed.text.join("").includes("f.txt"), "the collapsed heading lost its path");
});

await check("FileBlock explains a file it cannot render instead of drawing nothing", () => {
  for (const note of ["binary", "empty-file", "large", "unreadable", "omitted"]) {
    const file = { ...trackedFile, status: "untracked", note, hunks: [], additions: 0, deletions: 0 };
    const result = render(FileBlock, { file, open: true, onToggle: () => {}, t: (key) => `[${key}]` });
    assert.ok(result.text.includes(`[note.${note}]`), `no explanation drawn for note ${note}`);
    assert.equal(byClass(result, "dsh-diff__hunk").length, 0, `note ${note} still drew hunks`);
  }
  const ok = render(FileBlock, { file: trackedFile, open: true, onToggle: () => {}, t: (key) => `[${key}]` });
  assert.ok(!ok.text.some((value) => value.startsWith("[note.")), "a rendered file claimed a note");
});

await check("the file heading shows the stat only when there is something to count", () => {
  const withStat = render(FileBlock, { file: trackedFile, open: false, onToggle: () => {}, t: (key) => key });
  assert.deepEqual(byClass(withStat, "dsh-diff__statAdd").map((node) => node.props.children), ["+2"]);
  assert.deepEqual(byClass(withStat, "dsh-diff__statDel").map((node) => node.props.children), ["-1"]);
  const binary = { ...trackedFile, note: "binary", hunks: [] };
  const withoutStat = render(FileBlock, { file: binary, open: false, onToggle: () => {}, t: (key) => key });
  assert.equal(byClass(withoutStat, "dsh-diff__statAdd").length, 0, "a binary file still advertised a line count");
});

await check("each file row is marked +, -, or * by its change kind", () => {
  const marks = {
    added: "+",
    untracked: "+",
    copied: "+",
    deleted: "-",
    modified: "*",
    renamed: "*",
    conflicted: "*"
  };
  for (const [status, mark] of Object.entries(marks)) {
    const file = { ...trackedFile, status, hunks: [], note: "binary", additions: 0, deletions: 0 };
    const result = render(FileBlock, { file, open: false, onToggle: () => {}, t: (key) => key });
    const [badge] = byClass(result, "dsh-diff__badge");
    assert.ok(badge !== undefined, `no badge drawn for ${status}`);
    /* The mark is drawn, so the drawn path is the assertion. */
    const drawn = render(Mark, { mark });
    assert.equal(drawn.elements[0].type, "svg", `the ${mark} mark is not drawn`);
    assert.equal(drawn.elements[1].props.d, MARK_PATH[mark], `wrong geometry for the ${mark} mark`);
    /* The precise status still has to survive, for colour and for the tooltip. */
    assert.equal(badge.props["data-status"], status, `the status behind the mark was lost for ${status}`);
    assert.equal(badge.props["data-mark"], mark, `the mark attribute is missing for ${status}`);
    assert.equal(badge.props.title, `status.${status}`, `no tooltip word for ${status}`);
    /* The glyph is not a name, so the row carries the word. */
    const [head] = byClass(result, "dsh-diff__fileHead");
    assert.equal(head.props["aria-label"], `status.${status} ${file.path}`, `no accessible name for ${status}`);
  }
  /* An unknown status must still draw something rather than an empty box. */
  const odd = render(FileBlock, {
    file: { ...trackedFile, status: "mystery", hunks: [], note: "binary" },
    open: false,
    onToggle: () => {},
    t: (key) => key
  });
  assert.equal(byClass(odd, "dsh-diff__badge")[0].props["data-mark"], "*");
});

await check("the marks are drawn on a centred grid, not typed from a font", () => {
  /* A text glyph is placed by the font's baseline and side bearings, so centring
     the box leaves the ink off-centre: the plus sits left and low and the
     asterisk rides above the middle. Drawn paths are what make all three land on
     the same centre. */
  for (const [mark, path] of Object.entries(MARK_PATH)) {
    assert.ok(path.length > 0, `no geometry for the ${mark} mark`);
    const svg = render(Mark, { mark }).elements[0];
    assert.equal(svg.type, "svg", `the ${mark} mark is not an svg`);
    assert.equal(svg.props.stroke, "currentColor", `the ${mark} mark ignores the colour rules`);
    assert.equal(svg.props["aria-hidden"], "true", `the ${mark} mark is announced as text`);
    assert.ok(svg.props.width === svg.props.height, `the ${mark} mark's canvas is not square`);
    /* The grid is 10x10, so its centre is (5,5) and every mark must reach it. */
    assert.ok(path.includes("5 5") || path.includes("5 1.4") || path.includes("1.4 5"), `the ${mark} mark misses the centre`);
  }
  assert.equal(new Set(Object.values(MARK_PATH)).size, 3, "two marks draw the same geometry");
  /* Only the addition carries a vertical stroke; only the star crosses itself. */
  assert.ok(MARK_PATH["+"].includes("V"), "the plus lost its vertical stroke");
  assert.ok(!MARK_PATH["-"].includes("V"), "the minus grew a vertical stroke");
  assert.equal(MARK_PATH["*"].split("M").length - 1, 3, "the star is not three strokes");
});

await check("the disclosure triangle is drawn, and is one shape turned a quarter", () => {
  /* The `▸`/`▾` glyph pair it replaced rendered as a sliver at any font size
     small enough to fit the row, and was font-dependent like the marks. */
  const closed = render(Caret, { open: false }).elements;
  const open = render(Caret, { open: true }).elements;
  const svg = closed[0];
  assert.equal(svg.type, "svg", "the caret is not drawn");
  assert.equal(svg.props.className, "dsh-diff__caret");
  assert.equal(svg.props.width, svg.props.height, "the caret canvas is not square");
  assert.ok(svg.props.width >= 12, `the caret is still too small: ${svg.props.width}px`);
  assert.equal(svg.props["aria-hidden"], "true", "the caret is announced as text");
  /* The size the stylesheet enforces has to agree with the drawing, and it may
     not pin pixels: the whole panel tracks the app's font-size preference. */
  const caretRule = rule(".dsh-diff__caret");
  assert.match(caretRule, /width:var\(--dsh-diff-caret\)/, "the stylesheet does not size the caret from the scale");
  assert.match(caretRule, /height:var\(--dsh-diff-caret\)/, "the caret has no height of its own");
  assert.match(rule(".dsh-diff"), /--dsh-diff-caret:14px/, "the caret lost its size");
  assert.equal(closed[1].props.fill, "currentColor", "the caret ignores the theme colour");
  /* One path, so the two states cannot drift apart. */
  assert.equal(closed[1].props.d, open[1].props.d, "the two states draw different shapes");
  assert.equal(closed[1].props.transform, undefined, "the collapsed caret is already turned");
  assert.match(String(open[1].props.transform), /rotate\(90 5 5\)/, "the expanded caret is not turned about the grid centre");
});

await check("the badge is a centred square, not a word or a tall box", () => {
  const badge = rule(".dsh-diff__badge");
  const width = /width:var\((--dsh-diff-box)\)/.exec(badge);
  const height = /height:var\((--dsh-diff-box)\)/.exec(badge);
  assert.ok(width !== null && height !== null, `the mark has no fixed box: ${badge}`);
  /* One variable for both edges is what keeps the box square as it scales. */
  assert.equal(width[1], height[1], "the mark's box takes its edges from different variables");
  assert.ok(badge.includes("box-sizing:border-box"), "the mark's border would widen its box");
  assert.ok(badge.includes("justify-content:center"), "the mark is not centred horizontally");
  assert.ok(badge.includes("align-items:center"), "the mark is not centred vertically");
  assert.ok(badge.includes("inline-flex"), "the mark's box cannot centre a glyph without flex");
  /* No padding: a padded box would no longer measure square. */
  assert.ok(!/padding:[^;}]*[1-9]/.test(badge), `the mark's box is padded: ${badge}`);
});

await check("the panel keeps one fixed type scale, off the app's font-size preference", () => {
  /* The diff deliberately reads at one size however the conversation is set, so
     nothing here may read the preference the theme publishes on the body. */
  const root = rule(".dsh-diff");
  assert.match(root, /--dsh-diff-code:14px/, "the base size changed");
  /* The chrome reads at the diff's own size, not a step under it. */
  assert.match(root, /--dsh-diff-meta:var\(--dsh-diff-code\)/, "the chrome no longer reads at the diff's size");
  assert.match(root, /--dsh-diff-micro:calc\(var\(--dsh-diff-code\) - 2px\)/, "the micro step is not derived");
  assert.match(root, /--dsh-diff-strong:calc\(var\(--dsh-diff-code\) \+ 2px\)/, "the strong step is not derived");
  assert.match(root, /font-size:var\(--dsh-diff-meta\)/, "the panel does not size its text from the scale");
  /* The change itself is the panel's content, so it takes the largest step. */
  assert.match(rule(".dsh-diff__line"), /font-size:var\(--dsh-diff-code\)/, "the diff body ignores the scale");
  /* And the chrome matches it: toolbar, counts, and notices share that size. */
  for (const selector of [".dsh-diff__action", ".dsh-diff__counts", ".dsh-diff__notice", ".dsh-diff__root"]) {
    assert.match(rule(selector), /font-size:var\(--dsh-diff-meta\)/, `${selector} does not read at the chrome size`);
  }
  /* Nothing may pin a pixel size outside the scale, and nothing may follow the app. */
  const pinned = installedCss().match(/font-size:\s*\d+px/g);
  assert.equal(pinned, null, `a pinned font size bypasses the scale: ${String(pinned)}`);
  /* Reading it is what is forbidden; the comment above the scale names it on
     purpose, to record why the panel does not follow it. */
  for (const token of ["var(--dsh-content-font-size", "var(--dsh-content-font-delta"]) {
    assert.ok(!installedCss().includes(token), `the panel still follows the app setting through ${token}`);
  }
});

await check("the gutter and the marks are sized to the same scale", () => {
  const root = rule(".dsh-diff");
  assert.match(root, /--dsh-diff-gutter:32px/, "the gutter lost its size");
  assert.match(root, /--dsh-diff-mark:14px/, "the marks lost their size");
  assert.match(root, /--dsh-diff-box:18px/, "the mark box lost its size");
  assert.match(rule(".dsh-diff__no"), /width:var\(--dsh-diff-gutter\)/, "the gutter pins its width");
  /* The drawn mark fills whatever box the scale gives it. */
  assert.match(rule(".dsh-diff__badge svg"), /width:var\(--dsh-diff-mark\)/, "the drawn mark ignores the scale");
});

await check("the colour follows the symbol, so a mark means the same thing everywhere", () => {
  /* One colour per mark: green adds, red deletes, amber changes. Selecting on
     the mark rather than the status is what keeps renamed and conflicted from
     drifting away from modified when they all draw a star. */
  assert.match(rule(`.dsh-diff__badge[data-mark="+"]`), /state-success-primary/, "an addition is not green");
  assert.match(rule(`.dsh-diff__badge[data-mark="-"]`), /state-error-primary/, "a deletion is not red");
  assert.match(rule(`.dsh-diff__badge[data-mark="*"]`), /state-warn-primary/, "a change is not amber");
  /* Every status must land on one of the three coloured marks. */
  const marks = { added: "+", untracked: "+", copied: "+", deleted: "-", modified: "*", renamed: "*", conflicted: "*" };
  for (const [status, mark] of Object.entries(marks)) {
    assert.ok(rule(`.dsh-diff__badge[data-mark="${mark}"]`).includes("color:"), `mark ${mark} has no colour`);
    const file = { ...trackedFile, status, hunks: [], note: "binary" };
    const [badge] = byClass(render(FileBlock, { file, open: false, onToggle: () => {}, t: (key) => key }), "dsh-diff__badge");
    assert.equal(badge.props["data-mark"], mark, `${status} draws a mark with no colour rule`);
  }
});

await check("an untracked row is not announced twice", () => {
  const file = { ...trackedFile, status: "untracked", hunks: [], note: "binary" };
  const result = render(FileBlock, { file, open: false, onToggle: () => {}, t: (key) => key });
  assert.deepEqual(byClass(result, "dsh-diff__chip").map((node) => node.props.children), []);
});

console.log(failures === 0 ? "\nall checks passed" : `\n${String(failures)} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
