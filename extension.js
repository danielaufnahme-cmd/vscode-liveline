// Live Line (VSCodium extension).
// Shows which line of your code is running right now (soft background, like the
// cursor-line colour) and, when the program crashes, marks that line red with the
// error message. The red mark goes away as soon as you type in that file; moving
// the cursor or clicking around does nothing.
//
// How the running program talks to us: a Unix socket (LIVELINE_SOCK) that every
// integrated terminal gets in its environment.
//   - CPython: python/sitecustomize.py (on PYTHONPATH in VSCodium terminals) samples
//     the running line 20x per second; no tracing, so no slowdown.
//   - MicroPython / ESP32: tools/board.py hands "run" to python/mpy_run.py, which
//     adds tiny line markers to the code it sends and strips them from the output.
// Messages are JSON lines: start / pos / err / end.
const vscode = require("vscode");
const net = require("net");
const fs = require("fs");
const os = require("os");
const path = require("path");

let ctx;
let server = null;
let sockPath = null;
let nextConn = 1;
const running = new Map();   // connection id -> [{ file, line }]
let errors = new Map();      // file (fsPath) -> [{ line, col, endLine, endCol, msg, tb }]
let lastError = null;        // { file, line } for the status bar / reveal
let deco = {};
let statusItem;
let terminal = null;         // terminal of "Run Python File (Live Line)"
let refreshTimer = null;

// ---------------- decorations ----------------

function makeDecorations() {
  const media = (f) => vscode.Uri.file(path.join(ctx.extensionPath, "media", f));
  deco.run = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor("liveline.runningLineBackground"),
    overviewRulerColor: new vscode.ThemeColor("liveline.runningLineRuler"),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
    gutterIconPath: media("running.svg"),
    gutterIconSize: "70%",
  });
  deco.errLine = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor("liveline.errorLineBackground"),
    overviewRulerColor: new vscode.ThemeColor("editorError.foreground"),
    overviewRulerLane: vscode.OverviewRulerLane.Full,
    gutterIconPath: media("error.svg"),
    gutterIconSize: "70%",
  });
  deco.errCode = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor("liveline.errorCodeBackground"),
    borderRadius: "2px",
    textDecoration: "underline wavy",
  });
  deco.errText = vscode.window.createTextEditorDecorationType({
    after: {
      color: new vscode.ThemeColor("liveline.errorText"),
      margin: "0 0 0 2.5em",
      fontStyle: "italic",
    },
  });
  for (const d of Object.values(deco)) ctx.subscriptions.push(d);
}

const norm = (f) => path.resolve(f);

function scheduleRefresh() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => { refreshTimer = null; refresh(); }, 15);
}

function refresh() {
  const runByFile = new Map();
  for (const list of running.values()) {
    for (const p of list) {
      const f = norm(p.file);
      if (!runByFile.has(f)) runByFile.set(f, new Set());
      runByFile.get(f).add(p.line);
    }
  }
  const showText = vscode.workspace.getConfiguration("liveline").get("showErrorText", true);
  for (const ed of vscode.window.visibleTextEditors) {
    if (ed.document.uri.scheme !== "file") continue;
    const doc = ed.document;
    const f = norm(doc.uri.fsPath);
    const n = doc.lineCount;
    const lineRange = (l) => doc.lineAt(Math.min(Math.max(l, 1), n) - 1).range;

    const runLines = [...(runByFile.get(f) || [])].filter((l) => l >= 1 && l <= n);
    ed.setDecorations(deco.run, runLines.map((l) => lineRange(l)));

    const errs = (errors.get(f) || []).filter((e) => e.line >= 1 && e.line <= n);
    const lines = [], codes = [], texts = [];
    for (const e of errs) {
      const r = lineRange(e.line);
      const hover = new vscode.MarkdownString();
      hover.appendMarkdown("**The program stopped here**\n\n");
      hover.appendCodeblock(e.tb || e.msg, "text");
      lines.push({ range: r, hoverMessage: hover });
      const span = errorSpan(doc, e);
      if (span) codes.push({ range: span, hoverMessage: hover });
      if (showText) {
        texts.push({ range: new vscode.Range(r.end, r.end), renderOptions: { after: { contentText: "✖ " + e.msg } } });
      }
    }
    ed.setDecorations(deco.errLine, lines);
    ed.setDecorations(deco.errCode, codes);
    ed.setDecorations(deco.errText, texts);
  }
  updateStatus(runByFile);
}

// The exact code that broke. CPython 3.11+ tells us the columns; MicroPython
// does not, so guess from the message (missing name, attribute, key, module).
function errorSpan(doc, e) {
  const line = doc.lineAt(e.line - 1);
  if (e.col != null && e.col >= 0) {
    const endLine = Math.min(Math.max(e.endLine || e.line, e.line), doc.lineCount);
    let endCol = e.endCol != null ? e.endCol : line.text.length;
    if (endLine === e.line && endCol <= e.col) endCol = line.text.length;
    const r = new vscode.Range(e.line - 1, e.col, endLine - 1, endCol);
    return doc.validateRange(r);
  }
  const g = guessSpan(line.text, e.msg || "");
  return g ? new vscode.Range(e.line - 1, g[0], e.line - 1, g[1]) : null;
}

function guessSpan(text, msg) {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const word = (w) => new RegExp("(?<![\\w.])" + esc(w) + "(?!\\w)");
  const res = [];
  let m;
  if ((m = /name '([^']+)' (?:is not|isn't) defined/.exec(msg))) res.push(word(m[1]));
  else if ((m = /has no attribute '([^']+)'/.exec(msg))) res.push(new RegExp("\\.\\s*" + esc(m[1]) + "(?!\\w)"));
  else if ((m = /(?:no module named|cannot import name|can't import name) '([^']+)'/i.exec(msg))) res.push(word(m[1].split(".").pop()), word(m[1]));
  else if ((m = /^KeyError: (.+)$/.exec(msg))) res.push(new RegExp("\\[\\s*" + esc(m[1]) + "\\s*\\]"), new RegExp(esc(m[1])));
  else if (/^ZeroDivisionError/.test(msg)) res.push(/(?:\/\/?|%)\s*[\w.()[\]]+/);
  else if (/^IndexError/.test(msg)) res.push(/[\w.)\]]+\s*\[[^\]]*\]/);
  for (const re of res) {
    const hit = re.exec(text);
    if (hit) return [hit.index, hit.index + hit[0].length];
  }
  return null;
}

function updateStatus(runByFile) {
  const cur = [];
  for (const [f, lines] of runByFile) for (const l of lines) cur.push({ file: f, line: l });
  const hasAny = cur.length > 0 || errors.size > 0;
  vscode.commands.executeCommand("setContext", "liveline.hasHighlights", hasAny);
  if (cur.length) {
    const c = cur[0];
    statusItem.text = `$(debug-start) ${path.basename(c.file)}:${c.line}` + (cur.length > 1 ? ` (+${cur.length - 1})` : "");
    statusItem.tooltip = "Running now (Live Line). Click to go to this line.";
    statusItem.backgroundColor = undefined;
    statusItem.command = { command: "liveline.reveal", title: "", arguments: [c.file, c.line] };
    statusItem.show();
  } else if (lastError && errors.has(lastError.file)) {
    const e = (errors.get(lastError.file) || [])[0];
    statusItem.text = `$(error) ${path.basename(lastError.file)}:${lastError.line}  ${shorten(e ? e.msg : "error", 60)}`;
    statusItem.tooltip = "The program crashed here (Live Line). Click to go to the line.";
    statusItem.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
    statusItem.command = { command: "liveline.reveal", title: "", arguments: [lastError.file, lastError.line] };
    statusItem.show();
  } else {
    statusItem.hide();
  }
}

const shorten = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

async function reveal(file, line) {
  if (!file) return;
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  const ed = await vscode.window.showTextDocument(doc, { preserveFocus: false, preview: false });
  const l = Math.min(Math.max(line, 1), doc.lineCount) - 1;
  const r = doc.lineAt(l).range;
  ed.selection = new vscode.Selection(r.start, r.start);
  ed.revealRange(r, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

// ---------------- socket server ----------------

function onMessage(id, m, conn) {
  if (m.t === "start") {
    errors = new Map();
    lastError = null;
    conn.file = m.file;
  } else if (m.t === "pos") {
    running.set(id, (m.p || []).map((p) => ({ file: p[0], line: p[1] })));
  } else if (m.t === "err" && m.file && m.line) {
    const f = norm(m.file);
    if (!m.thread) running.delete(id);          // the program is stopping
    const e = { line: m.line, col: m.col, endLine: m.endLine, endCol: m.endCol, msg: m.msg || "Error", tb: m.tb };
    errors.set(f, [e]);
    lastError = { file: f, line: m.line };
  } else if (m.t === "end") {
    running.delete(id);
  }
  scheduleRefresh();
}

function startServer() {
  sockPath = path.join(os.tmpdir(), `liveline-${process.pid}-${Math.random().toString(36).slice(2, 8)}.sock`);
  try { fs.unlinkSync(sockPath); } catch (e) { /* not there */ }
  server = net.createServer((conn) => {
    const id = nextConn++;
    let buf = "";
    conn.setEncoding("utf8");
    conn.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        try { onMessage(id, JSON.parse(line), conn); } catch (e) { console.log("[liveline] bad message", e); }
      }
    });
    const done = () => { if (running.delete(id)) scheduleRefresh(); };
    conn.on("close", done);
    conn.on("error", done);
  });
  server.on("error", (e) => console.log("[liveline] server error", e));
  server.listen(sockPath);
}

// ---------------- terminal environment ----------------

function roots() {
  return (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
}

function applyEnv() {
  const env = ctx.environmentVariableCollection;
  env.persistent = false;
  try { env.description = "Live Line: shows the line your Python code is running"; } catch (e) { /* old API */ }
  env.clear();
  env.replace("LIVELINE_SOCK", sockPath);
  env.replace("LIVELINE_ROOTS", roots().join(path.delimiter));
  env.replace("LIVELINE_MPY_RUNNER", path.join(ctx.extensionPath, "python", "mpy_run.py"));
  if (vscode.workspace.getConfiguration("liveline").get("traceTerminalPython", true)) {
    env.replace("PYTHONPATH", pythonPath(process.env.PYTHONPATH));
  }
}

function pythonPath(existing) {
  const dir = path.join(ctx.extensionPath, "python");
  return existing ? dir + path.delimiter + existing : dir;
}

// ---------------- Run Python File (normal VSCodium) ----------------

function pickPython(file) {
  const cfg = vscode.workspace.getConfiguration("liveline").get("pythonPath", "");
  if (cfg) return cfg;
  const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(file));
  const dirs = [];
  if (folder) dirs.push(folder.uri.fsPath);
  dirs.push(path.dirname(file));
  for (const d of dirs) {
    for (const v of [".venv", "venv"]) {
      const p = path.join(d, v, "bin", "python");
      if (fs.existsSync(p)) return p;
    }
  }
  return "python3";
}

async function runPython() {
  const ed = vscode.window.activeTextEditor;
  if (!ed || ed.document.languageId !== "python") {
    vscode.window.showWarningMessage("Open a Python file first.");
    return;
  }
  if (ed.document.isUntitled) await vscode.commands.executeCommand("workbench.action.files.saveAs");
  else if (ed.document.isDirty) await ed.document.save();
  if (ed.document.isUntitled) return;
  const file = ed.document.uri.fsPath;

  let closed = false;
  for (const t of vscode.window.terminals) {
    if (t === terminal || t.name === "Live Line") { t.dispose(); closed = true; }
  }
  terminal = null;
  if (closed) await new Promise((r) => setTimeout(r, 300));
  const keepOpen = '"$@"; code=$?; echo; ' +
    'if [ $code -eq 0 ]; then echo "── finished ── press any key to close (F5 runs again)"; ' +
    'elif [ $code -eq 130 ]; then echo "── stopped ── press any key to close"; ' +
    'else echo "── crashed (exit code $code) ── press any key to close"; fi; read -r -s -n 1';
  const r = new Set(roots());
  r.add(path.dirname(file));
  terminal = vscode.window.createTerminal({
    name: "Live Line",
    cwd: path.dirname(file),
    shellPath: "/bin/bash",
    shellArgs: ["-c", keepOpen, "liveline", pickPython(file), "-u", file],
    env: {
      LIVELINE_SOCK: sockPath,
      LIVELINE_ROOTS: [...r].join(path.delimiter),
      LIVELINE_FORCE: "1",
      PYTHONPATH: pythonPath(process.env.PYTHONPATH),
    },
    iconPath: new vscode.ThemeIcon("play"),
  });
  terminal.show(true);
  vscode.commands.executeCommand("setContext", "liveline.terminalRunning", true);
}

function stop() {
  if (terminal) terminal.sendText("\x03", false);   // Ctrl-C -> KeyboardInterrupt (not marked red)
}

// ---------------- deduplicate tabs & terminals ----------------

function tabKey(tab) {
  const inp = tab.input;
  if (!inp) return "label:" + tab.label;
  if (inp.uri) return "uri:" + inp.uri.toString();
  if (inp.modified && inp.original) return "diff:" + inp.original.toString() + "->" + inp.modified.toString();
  if (inp.viewType) return "view:" + inp.viewType + ":" + tab.label;
  return "label:" + tab.label;
}

let dedupingTabs = false;
async function dedupeTabs() {
  if (dedupingTabs) return;
  dedupingTabs = true;
  try {
    const groups = vscode.window.tabGroups.all;
    // Pass 1: active tabs win over inactive duplicate tabs
    // Pass 2: if multiple inactive duplicates exist, keep the newest/last one
    const seen = new Map(); // key -> tab to keep
    for (const g of groups) {
      for (const t of g.tabs) {
        if (t.isActive) seen.set(tabKey(t), t);
      }
    }
    const toClose = [];
    for (const g of groups) {
      for (const t of g.tabs) {
        const k = tabKey(t);
        const keep = seen.get(k);
        if (!keep) {
          seen.set(k, t);
        } else if (keep !== t) {
          if (!keep.isActive && !t.isActive) {
            toClose.push(keep);
            seen.set(k, t);
          } else {
            toClose.push(t);
          }
        }
      }
    }
    if (toClose.length) {
      try { await vscode.window.tabGroups.close(toClose, true); } catch (e) { /* ignore */ }
    }
  } finally {
    dedupingTabs = false;
  }
}

function termCwd(t) {
  const c = t.creationOptions && t.creationOptions.cwd;
  if (!c) return "";
  return typeof c === "string" ? path.resolve(c) : c.fsPath ? path.resolve(c.fsPath) : String(c);
}

function dedupeTerminals(newest) {
  const list = vscode.window.terminals;
  if (list.length <= 1) return;
  if (newest) {
    const name = newest.name;
    const cwd = termCwd(newest);
    for (const t of list) {
      if (t !== newest && t.name === name && termCwd(t) === cwd) {
        try { t.dispose(); } catch (e) { /* ignore */ }
      }
    }
    return;
  }
  const seen = new Map();
  for (const t of list) {
    const k = t.name + "::" + termCwd(t);
    const prev = seen.get(k);
    if (prev) { try { prev.dispose(); } catch (e) { /* ignore */ } }
    seen.set(k, t);
  }
}

// ---------------- activation ----------------

function activate(context) {
  ctx = context;
  makeDecorations();
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
  context.subscriptions.push(statusItem);
  startServer();
  applyEnv();

  const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  reg("liveline.runPython", runPython);
  reg("liveline.stop", stop);
  reg("liveline.clear", () => { running.clear(); errors = new Map(); lastError = null; refresh(); });
  reg("liveline.reveal", reveal);

  context.subscriptions.push(
    vscode.window.onDidChangeVisibleTextEditors(scheduleRefresh),
    vscode.window.tabGroups.onDidChangeTabs(() => setTimeout(dedupeTabs, 50)),
    vscode.window.onDidOpenTerminal((t) => setTimeout(() => dedupeTerminals(t), 50)),
    // Typing in a file removes its red mark. Cursor moves / clicks are not text changes.
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (!e.contentChanges.length || e.document.uri.scheme !== "file") return;
      const f = norm(e.document.uri.fsPath);
      if (errors.delete(f)) {
        if (lastError && lastError.file === f) lastError = null;
        scheduleRefresh();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(applyEnv),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("liveline.traceTerminalPython")) applyEnv();
      if (e.affectsConfiguration("liveline")) scheduleRefresh();
    }),
    vscode.window.onDidCloseTerminal((t) => {
      if (t === terminal) {
        terminal = null;
        vscode.commands.executeCommand("setContext", "liveline.terminalRunning", false);
      }
    }),
    { dispose: shutdown },
  );
  setTimeout(() => { dedupeTabs(); dedupeTerminals(); }, 300);
}

function shutdown() {
  if (server) { server.close(); server = null; }
  if (sockPath) { try { fs.unlinkSync(sockPath); } catch (e) { /* gone */ } }
}

function deactivate() { shutdown(); }

module.exports = { activate, deactivate, _test: { guessSpan } };
