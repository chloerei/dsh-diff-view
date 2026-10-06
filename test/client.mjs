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

/** Whether the bundle installed its stylesheet, and the CSS it installed. */
let styled = false;
let installedCss = "";

/**
 * Load the bundle the way the Harness page does.
 * @returns the bundle's exports.
 */
function loadBundle() {
  const window = { __ModuleLoader__: { load: (value) => (registration = value) } };
  let registration;
  const document = {
    querySelector: () => (styled ? {} : null),
    createElement: () => ({ dataset: {}, textContent: "" }),
    head: {
      appendChild: (tag) => {
        styled = true;
        installedCss = tag.textContent;
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
const { Gutter, Hunks, FileBlock } = bundle.__internals;

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
  assert.deepEqual(bundle.inject, ["slots", "locale", "sidebarRight", "sidebarRightTabs"]);
  assert.equal(typeof Gutter, "function");
  assert.equal(typeof Hunks, "function");
  assert.equal(typeof FileBlock, "function");
});

await check("the stylesheet is installed once, tagged with the package", () => {
  assert.equal(styled, true, "the bundle never installed its CSS");
  assert.ok(installedCss.length > 0, "the installed stylesheet is empty");
});

/**
 * Read one rule's declarations out of the installed stylesheet.
 * @param selector - the exact selector, including any attribute part.
 * @returns the declarations between its braces.
 */
function rule(selector) {
  const pattern = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\{([^}]*)\\}`);
  const match = pattern.exec(installedCss);
  assert.ok(match !== null, `no CSS rule for ${selector}`);
  return match[1];
}

await check("long diff lines wrap instead of overflowing the panel", () => {
  const line = rule(".dsh-diff__line");
  assert.ok(line.includes("white-space:pre-wrap"), `.dsh-diff__line must wrap, got: ${line}`);
  assert.ok(line.includes("overflow-wrap:anywhere"), `.dsh-diff__line must break unbroken tokens, got: ${line}`);
  /* The hunk header used to be the other sideways-scrolling surface. */
  assert.ok(!rule(".dsh-diff__hunkHead").includes("overflow-x:auto"), "the hunk header can still scroll sideways");
  assert.ok(!installedCss.includes("overflow-x:auto"), "a horizontal scroll surface remains");
});

await check("the diff body is inset from the panel edges", () => {
  assert.match(rule(".dsh-diff__line"), /padding-left:\s*\d/, "diff lines are flush against the left edge");
  assert.match(rule(".dsh-diff__code"), /padding-right:\s*\d/, "diff lines are flush against the right edge");
  assert.match(rule(".dsh-diff__hunkHead"), /padding:\s*\S+\s+\S+/, "the hunk header lost its inset");
});

await check("apply registers the dictionary, the tab type, and the tab body", () => {
  const calls = { locale: [], tabs: [], slots: [] };
  const ctx = {
    effect: (fn) => fn(),
    locale: {
      register: (ns, dicts) => calls.locale.push({ ns, dicts }),
      bind: () => (key) => key
    },
    sidebarRightTabs: { register: (definition) => calls.tabs.push(definition) },
    slots: {
      inject: (slot) => {
        calls.slots.push(slot);
        return () => {};
      },
      register: (options, component) => ({ options, component })
    }
  };
  bundle.apply(ctx);

  assert.deepEqual(calls.locale.map((entry) => entry.ns), ["dshDiffViewer"]);
  assert.ok(calls.locale[0].dicts.en["tab.title"] !== undefined, "the English dictionary is incomplete");
  assert.ok(calls.locale[0].dicts.zh["tab.title"] !== undefined, "the Chinese dictionary is incomplete");

  assert.equal(calls.tabs.length, 1);
  const type = calls.tabs[0];
  assert.equal(type.id, "dsh-diff-viewer");
  assert.equal(type.kind, "dsh-diff-viewer");
  assert.equal(type.multiple, true);
  assert.equal(type.title(), "tab.title");
  assert.deepEqual(type.guide.map((entry) => entry.id), ["open"]);
  assert.ok(calls.slots.includes("sidebar.right.pane.tab"), "the tab body slot was not injected");
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

console.log(failures === 0 ? "\nall checks passed" : `\n${String(failures)} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
