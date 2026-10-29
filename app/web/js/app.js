/* ============================================================
   飞书机器人管家 · 前端逻辑
   无框架，纯 DOM。所有系统调用都走 window.pywebview.api，
   在浏览器里打开时自动落到 MOCK，方便调样式。
   ============================================================ */
const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

const state = {
  cfg: null,
  status: { running: false, pid: null, uptime: 0 },
  preflight: { ok: true, issues: [] },
  logs: [],
  lastId: 0,
  level: "all",
  search: "",
  autoscroll: true,
  plugins: [],
  pluginDefs: [],
  page: "overview",
  bootTime: Date.now(),
};

/* ---------------------------------------------------------- 桥 */
const MOCK = {
  bootstrap: () => ({
    app: { name: "飞书机器人管家", version: "1.0.2", frozen: false },
    config: { bot: { dir: "…\\feishu-deepseek-bot", node: "node", autoStart: false, stopOnExit: true }, ui: { animation: "smooth", theme: "dark", accent: "#0a8f47" }, window: { frameless: true } },
    status: { running: true, pid: 12088, uptime: 3725, botDir: "…\\feishu-deepseek-bot", node: "node" },
    preflight: { ok: true, issues: [{ level: "warn", text: "没有 .env，机器人启动后会因为缺凭证报错" }] },
    animations: window.ANIM_PRESETS,
    envFields: [
      { key: "FEISHU_APP_ID", label: "飞书 App ID", group: "飞书", placeholder: "cli_xxxxxxxx" },
      { key: "FEISHU_APP_SECRET", label: "飞书 App Secret", group: "飞书", secret: true },
      { key: "DEEPSEEK_MODEL", label: "模型", group: "模型", placeholder: "deepseek-flash" },
      { key: "DEEPSEEK_BASE_URL", label: "接口地址", group: "模型", placeholder: "https://api.deepseek.com" },
      { key: "DEEPSEEK_API_KEY", label: "API Key", group: "模型", secret: true },
      { key: "SYSTEM_PROMPT", label: "人设提示词", group: "人设", multiline: true },
    ],
    plugins: [{ id: "hello", name: "示例插件", version: "1.0.0", description: "演示插件能做什么", hasUi: true, hasBackend: true, enabled: true }],
    autostart: false,
    platform: { os: "nt", py: "3.13" },
  }),
  get_status: () => ({ ...state.status, uptime: state.status.running ? Math.floor((Date.now() - state.bootTime) / 1000) + 3600 : 0 }),
  get_logs: () => [],
  get_env: () => ({ ok: true, path: "…\\.env", exists: true, raw: "", values: { FEISHU_APP_ID: "cli_demo", DEEPSEEK_MODEL: "deepseek-flash" } }),
  get_docs: () => ({ ok: true, path: "…\\docs.json", raw: '{\n  "docs": [],\n  "folders": []\n}\n' }),
  list_docs: () => ({
    ok: true,
    path: "…\\docs.json",
    docs: [
      { index: 0, name: "产品手册", url: "https://x.feishu.cn/docx/Abc123", token: "Abc123", docType: "文档", writable: true },
      { index: 1, name: "周报", url: "https://x.feishu.cn/wiki/Def456", token: "Def456", docType: "知识库", writable: false },
    ],
  }),
  add_doc: () => ({ ok: true, path: "…\\docs.json", docs: [] }),
  remove_doc: () => ({ ok: true, docs: [] }),
  rename_doc: () => ({ ok: true, docs: [] }),
  set_doc_writable: () => ({ ok: true, docs: [] }),
  get_preflight: () => state.preflight,
  plugin_ui: () => [],
  plugin_list: () => state.plugins,
  import_plugin_drop: () => ({ ok: false, error: "浏览器预览里不能导入插件", imported: [], errors: [] }),
  start_bot: () => ({ ok: true, pid: 4242 }),
  stop_bot: () => ({ ok: true }),
  restart_bot: () => ({ ok: true }),
  save_settings: () => ({ ok: true }),
  save_env: () => ({ ok: true }),
  save_env_raw: () => ({ ok: true }),
  save_docs: () => ({ ok: true }),
  set_ui: () => ({ ok: true }),
  set_autostart: (v) => ({ ok: true, enabled: v }),
  export_logs: () => ({ ok: true, path: "C:\\logs.txt" }),
  clear_logs: () => true,
  open_path: () => true,
  open_feishu_console: () => ({ ok: true, exact: true, url: "https://open.feishu.cn/app/cli_demo/baseinfo" }),
  open_plugins_dir: () => true,
  pick_folder: () => null,
  use_bundled_bot: () => ({ ok: true, dir: "C:/demo/FeishuBotManager/bot" }),
  win_minimize: () => {},
  win_toggle_max: () => {},
  win_close: () => {},
  win_drag: () => {},
  win_resize: () => {},
  quit_app: () => {},
};

const bridge = (() => {
  // pywebview 注入是两段的：先挂 window.pywebview，再往里塞方法。
  // 所以不能只看对象在不在，必须等到"某个具体方法变成函数"。
  let readyFlag = false;
  window.addEventListener("pywebviewready", () => {
    readyFlag = true;
  });

  function waitMethod(name, timeout = 10000) {
    const has = () => window.pywebview && window.pywebview.api && typeof window.pywebview.api[name] === "function";
    if (has()) {
      readyFlag = true;
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const started = Date.now();
      const timer = setInterval(() => {
        if (has()) {
          clearInterval(timer);
          readyFlag = true;
          resolve(true);
        } else if (Date.now() - started > timeout) {
          clearInterval(timer);
          resolve(false);
        }
      }, 60);
    });
  }

  async function call(name, ...args) {
    // 浏览器里预览时不用干等，400ms 没 API 就直接上假数据
    const inApp = "pywebview" in window;
    const ok = await waitMethod(name, inApp ? 10000 : 400);
    if (ok) return window.pywebview.api[name](...args);

    if (!inApp) {
      const mock = MOCK[name];
      return mock ? mock(...args) : null;
    }
    throw new Error(`后端接口 ${name} 未就绪`);
  }

  return { call, waitMethod, get ready() { return readyFlag; } };
})();

/* ---------------------------------------------------------- 小工具 */
const _toastSeen = new Map();
function toast(text, kind = "ok") {
  // 同一条提示 4 秒内只弹一次：连点几次启动、或轮询重复报同一个错时不刷屏
  const key = `${kind}:${text}`;
  const now = Date.now();
  if (now - (_toastSeen.get(key) || 0) < 4000) return;
  _toastSeen.set(key, now);
  const box = $("#toasts");
  const node = document.createElement("div");
  node.className = `toast ${kind}`;
  node.innerHTML = `<i class="dot"></i><span></span>`;
  node.querySelector("span").textContent = text;
  box.appendChild(node);
  setTimeout(() => {
    node.style.opacity = "0";
    node.style.transform = "translateY(6px)";
    setTimeout(() => node.remove(), 220);
  }, 2600);
}

const pad = (n) => String(n).padStart(2, "0");
function fmtUptime(sec) {
  const s = Math.max(0, sec | 0);
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/* ---------------------------------------------------------- 页面切换 */
function go(page) {
  state.page = page;
  $$(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.page === page));
  $$(".page").forEach((p) => p.classList.toggle("active", p.dataset.page === page));
  $("#content").scrollTop = 0;
  const def = state.pluginDefs.find((d) => `plugin:${d.id}` === page);
  if (def) mountPlugin(def);
}

/* ---------------------------------------------------------- 渲染：状态 */
function renderStatus() {
  const s = state.status || {};
  const on = !!s.running;

  $("#tbBadge").textContent = on ? "运行中" : "已停止";
  $("#tbBadge").classList.toggle("on", on);
  $("#sideDot").classList.toggle("on", on);
  $("#sideState").textContent = on ? "运行中" : "已停止";
  $("#sideMeta").textContent = on ? `PID ${s.pid}` : "点概览页启动";

  $("#stateRing").classList.toggle("on", on);
  $("#heroTitle").textContent = on ? "机器人正在运行" : "机器人已停止";
  $("#heroDesc").textContent = on ? "在飞书群里 @ 它就能对话了" : "点右边的启动按钮，或让我随管家一起启动";
  $("#chipPid").textContent = `PID ${on ? s.pid : "—"}`;
  $("#chipUptime").textContent = `运行 ${fmtUptime(s.uptime || 0)}`;

  $("#btnStart").disabled = on;
  $("#btnStop").disabled = !on;
  $("#btnRestart").disabled = !on;

  $("#miniDir").textContent = s.botDir || "未设置";
  $("#miniNode").textContent = s.node || "node";

  const issues = (state.preflight && state.preflight.issues) || [];
  const errs = issues.filter((i) => i.level === "error").length;
  $("#miniCheck").innerHTML = issues.length
    ? `<span style="color:${errs ? "var(--err)" : "var(--warn)"}">${errs ? errs + " 项阻塞" : issues.length + " 项提醒"}</span>`
    : `<span style="color:var(--ok)">一切正常</span>`;
}

/* ---------------------------------------------------------- 渲染：日志 */
const LOG_SRC = { bot: "BOT", plugin: "PLG", manager: "MGR" };

function logLine(item, opts = {}) {
  const src = esc(LOG_SRC[item.source] || item.source);
  const kindCls = item.kind ? ` kind-${esc(item.kind)}` : "";
  const head = `<span class="log-time">${esc(item.time)}</span>
    <span class="log-src ${esc(item.source)}">${src}</span>`;

  // 带明细的问答日志（提问 / 回复）：一行摘要 + 可展开的全文
  if (item.detail && opts.fold !== false) {
    return `<div class="log-line ${item.level}${kindCls}" data-level="${item.level}">
      ${head}
      <details class="log-fold">
        <summary><span class="log-text">${esc(item.text)}</span><span class="log-exp"></span></summary>
        <pre class="log-body">${esc(item.detail)}</pre>
      </details>
    </div>`;
  }

  return `<div class="log-line ${item.level}${kindCls}" data-level="${item.level}">
    ${head}
    <span class="log-text">${esc(item.text)}</span>
  </div>`;
}

function match(item) {
  if (state.level !== "all" && item.level !== state.level) return false;
  if (state.search && !(item.text || "").toLowerCase().includes(state.search)) return false;
  return true;
}

function renderLogs() {
  const shown = state.logs.filter(match);
  const view = $("#logView");
  if (!shown.length) {
    view.innerHTML = `<div class="empty">${state.logs.length ? "没有匹配的日志" : "等待输出…"}</div>`;
  } else {
    view.innerHTML = shown.map(logLine).join("");
    if (state.autoscroll) view.scrollTop = view.scrollHeight;
  }
  $("#logMeta").textContent = `共 ${state.logs.length} 行，显示 ${shown.length} 行`;

  const tail = state.logs.slice(-6);
  $("#logMini").innerHTML = tail.length
    ? tail.map(logLine).join("")
    : `<div class="empty">还没有输出</div>`;
}

function appendLogs(items) {
  if (!items || !items.length) return;
  state.logs.push(...items);
  if (state.logs.length > 2600) state.logs = state.logs.slice(-2600);
  state.lastId = state.logs[state.logs.length - 1].id;

  const view = $("#logView");
  const fresh = items.filter(match);
  if (fresh.length && !$("#logView .empty")) {
    view.insertAdjacentHTML("beforeend", fresh.map(logLine).join(""));
    if (state.autoscroll) view.scrollTop = view.scrollHeight;
  } else if (fresh.length) {
    view.innerHTML = state.logs.filter(match).map(logLine).join("");
    if (state.autoscroll) view.scrollTop = view.scrollHeight;
  }
  $("#logMeta").textContent = `共 ${state.logs.length} 行，显示 ${state.logs.filter(match).length} 行`;
  const tail = state.logs.slice(-6);
  $("#logMini").innerHTML = tail.map(logLine).join("");
}

/* ---------------------------------------------------------- 渲染：配置表单 */
// 这两项要在飞书开放平台后台核对/复制，行内给个直达入口
const CONSOLE_KEYS = new Set(["FEISHU_APP_ID", "FEISHU_APP_SECRET"]);

function renderEnvForm(values) {
  const form = $("#envForm");
  form.innerHTML = "";
  const fields = state.envFields || [];
  for (const f of fields) {
    const val = values[f.key] ?? "";
    const wrap = document.createElement("div");
    wrap.className = "field" + (f.multiline ? " wide" : "");
    const tag = f.group ? `<span class="group-tag">${esc(f.group)}</span>` : "";
    const control = f.multiline
      ? `<textarea data-key="${f.key}" rows="3" placeholder="${esc(f.placeholder || "")}">${esc(val)}</textarea>`
      : f.secret
        ? `<div class="secret-wrap"><input type="password" data-key="${f.key}" value="${esc(val)}" placeholder="${esc(f.placeholder || "")}" /><button class="eye" data-eye="${f.key}">显示</button></div>`
        : `<input data-key="${f.key}" value="${esc(val)}" placeholder="${esc(f.placeholder || "")}" />`;
    const help =
      f.key === "FEISHU_APP_ID"
        ? `<button type="button" class="field-link field-help" title="飞书应用怎么配：6 步说明">配置说明</button>`
        : "";
    const link = CONSOLE_KEYS.has(f.key)
      ? `<button type="button" class="field-link" data-console="${f.key}" title="打开飞书开放平台">
           <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/></svg>
           开放平台</button>`
      : "";
    wrap.innerHTML = `<label>${esc(f.label)}${tag}${help}${link}</label>${control}`;
    form.appendChild(wrap);
  }
  $$(".eye", form).forEach((b) =>
    b.addEventListener("click", () => {
      const input = $(`input[data-key="${b.dataset.eye}"]`, form);
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      b.textContent = show ? "隐藏" : "显示";
    }),
  );
  $$(".field-help", form).forEach((b) => b.addEventListener("click", openHelp));
  $$(".field-link[data-console]", form).forEach((b) =>
    b.addEventListener("click", async (e) => {
      e.preventDefault();
      const r = await bridge.call("open_feishu_console").catch((err) => ({ ok: false, error: String(err.message || err) }));
      if (!r || !r.ok) {
        toast((r && r.error) || "打不开飞书开放平台", "err");
        return;
      }
      toast(r.exact ? "已打开飞书应用凭证页" : "已打开飞书开放平台，登录后选你的应用");
    }),
  );
}

function collectEnv() {
  const out = {};
  $$("[data-key]", $("#envForm")).forEach((el) => {
    out[el.dataset.key] = el.value;
  });
  return out;
}

async function loadEnv() {
  const info = await bridge.call("get_env");
  if (!info || !info.ok) {
    toast(info && info.error ? info.error : "读取 .env 失败", "err");
    return;
  }
  $("#envPath").textContent = info.path + (info.exists ? "" : "（文件还不存在，保存时会创建）");
  renderEnvForm(info.values || {});
  $("#envRaw").value = info.raw || "";
}

function renderDocList(docs) {
  const box = $("#docList");
  if (!docs.length) {
    box.innerHTML = `<div class="empty">还没有文档。把飞书文档链接粘到上面，点「添加」。</div>`;
    return;
  }
  box.innerHTML = docs
    .map(
      (d) => `<div class="doc-row" data-index="${d.index}">
        <div class="doc-main">
          <input class="doc-name" value="${esc(d.name)}" />
          <div class="doc-meta">${esc(d.docType)} · ${esc(d.token || d.url)}</div>
        </div>
        <span class="doc-tag ${d.writable ? "ok" : ""}">${d.writable ? "可读写" : "只读"}</span>
        <label class="switch sm" title="可读写 / 只读"><input type="checkbox" class="doc-w" ${d.writable ? "checked" : ""}/><span></span></label>
        <button class="doc-del" title="从清单移除">✕</button>
      </div>`,
    )
    .join("");

  $$(".doc-row", box).forEach((row) => {
    const idx = Number(row.dataset.index);

    $(".doc-name", row).addEventListener("change", async (e) => {
      const name = e.target.value.trim();
      if (!name) return;
      await bridge.call("rename_doc", idx, name);
      toast("名称已更新");
    });

    $(".doc-w", row).addEventListener("change", async (e) => {
      await bridge.call("set_doc_writable", idx, e.target.checked);
      toast(e.target.checked ? "已设为可读写" : "已设为只读");
      await loadDocs();
    });

    $(".doc-del", row).addEventListener("click", async () => {
      const r = await bridge.call("remove_doc", idx);
      if (r && r.ok) {
        renderDocList(r.docs || []);
        const info = await bridge.call("get_docs");
        if (info && info.ok) $("#docsEditor").value = info.raw || "";
        toast("已从清单移除");
      } else toast((r && r.error) || "移除失败", "err");
    });
  });
}

async function loadDocs() {
  const list = await bridge.call("list_docs");
  if (list && list.ok) {
    renderDocList(list.docs || []);
    $("#docsPath").textContent = `${(list.docs || []).length} 篇 · ${list.path}`;
  }
  const info = await bridge.call("get_docs");
  if (info && info.ok) $("#docsEditor").value = info.raw || "";
}

/* ---------------------------------------------------------- 渲染：设置 */
function renderSettings() {
  const ui = (state.cfg && state.cfg.ui) || {};
  const list = state.animations || window.ANIM_PRESETS;
  const grid = $("#animGrid");
  grid.innerHTML = list
    .map(
      (a) => `<button class="anim-card ${a.id === ui.animation ? "active" : ""}" data-id="${a.id}">
        <div class="anim-demo"><i></i></div>
        <div class="anim-name">${esc(a.name)}</div>
        <div class="anim-desc">${esc(a.desc)}</div>
      </button>`,
    )
    .join("");
  $$(".anim-card", grid).forEach((b) =>
    b.addEventListener("click", async () => {
      const id = b.dataset.id;
      window.applyAnimation(id);
      $$(".anim-card").forEach((x) => x.classList.toggle("active", x === b));
      await bridge.call("set_ui", { animation: id });
      // 重放一次页面动画，让用户立刻看到效果
      const page = $(".page.active");
      if (page) {
        page.style.animation = "none";
        void page.offsetWidth;
        page.style.animation = "";
      }
      toast(`已切换到「${b.querySelector(".anim-name").textContent}」`);
    }),
  );

  const theme = ui.theme || "dark";
  document.documentElement.dataset.theme = theme;
  $$("#themeSeg button").forEach((b) => b.classList.toggle("active", b.dataset.theme === theme));
}

/* ---------------------------------------------------------- 渲染：插件 */
function renderPlugins() {
  const box = $("#pluginList");
  if (!state.plugins.length) {
    box.innerHTML = `<div class="card"><div class="empty">还没有插件。把插件文件夹放进 plugins 目录，点「重新加载」。</div></div>`;
    return;
  }
  box.innerHTML = state.plugins
    .map(
      (p) => `<div class="plugin-card">
      <div class="plugin-top">
        <div>
          <div class="plugin-name">${esc(p.name)} <span class="plugin-ver">v${esc(p.version)}</span></div>
          <div class="plugin-desc">${esc(p.description || "没有描述")}</div>
        </div>
        <label class="switch"><input type="checkbox" data-plugin="${esc(p.id)}" ${p.enabled ? "checked" : ""}/><span></span></label>
      </div>
      <div class="plugin-tags">
        ${p.hasUi ? '<span class="tag ok">界面</span>' : ""}
        ${p.hasBackend ? '<span class="tag ok">后端</span>' : ""}
        ${p.enabled ? "" : '<span class="tag">已停用</span>'}
        ${p.error ? `<span class="tag err">${esc(p.error)}</span>` : ""}
      </div>
    </div>`,
    )
    .join("");
  $$("[data-plugin]", box).forEach((el) =>
    el.addEventListener("change", async () => {
      await bridge.call("plugin_toggle", el.dataset.plugin, el.checked);
      await refreshPlugins();
      toast(el.checked ? "插件已启用" : "插件已停用");
    }),
  );
}

async function refreshPlugins() {
  state.plugins = (await bridge.call("plugin_list")) || [];
  renderPlugins();
  await loadPluginUi();
}

/* ---------------------------------------------------------- 拖入安装插件 */
let dropDepth = 0;
let dropBytes = 0;
const DROP_LIMIT = 30 * 1024 * 1024;

function hasFiles(e) {
  const types = e.dataTransfer && e.dataTransfer.types;
  return !!types && Array.from(types).includes("Files");
}

function readB64(file) {
  return new Promise((resolve, reject) => {
    dropBytes += file.size || 0;
    if (dropBytes > DROP_LIMIT) {
      reject(new Error("一次最多拖 30 MB"));
      return;
    }
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || "").split(",", 2)[1] || "");
    fr.onerror = () => reject(fr.error || new Error("读不出文件内容"));
    fr.readAsDataURL(file);
  });
}

function entryFile(entry) {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

async function walkDir(dir, prefix) {
  const reader = dir.createReader();
  const out = [];
  let batch;
  do {
    batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
    for (const entry of batch) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory) out.push(...(await walkDir(entry, rel)));
      else out.push({ rel, b64: await readB64(await entryFile(entry)) });
    }
  } while (batch.length);
  return out;
}

async function collectDrops(dt) {
  dropBytes = 0;
  const payload = [];
  // WebView2 拿不到磁盘路径，只能顺着 entry 树把内容读出来
  const entries = Array.from(dt.items || [])
    .map((item) => (item.kind === "file" && item.webkitGetAsEntry ? item.webkitGetAsEntry() : null))
    .filter(Boolean);
  if (entries.length) {
    for (const entry of entries) {
      if (entry.isDirectory) payload.push({ kind: "folder", name: entry.name, files: await walkDir(entry, "") });
      else payload.push({ kind: "zip", name: entry.name, b64: await readB64(await entryFile(entry)) });
    }
    return payload;
  }
  for (const file of Array.from(dt.files || [])) {
    payload.push({ kind: "zip", name: file.name, b64: await readB64(file) });
  }
  return payload;
}

async function importDropped(dt) {
  const items = await collectDrops(dt);
  if (!items.length) return;
  const res = await bridge.call("import_plugin_drop", items);
  if (res && res.ok) {
    toast(`已导入插件 ${res.imported.join("、")}`, "ok");
  } else if (res && res.errors && res.errors.length) {
    toast(res.errors.join("；"), "err");
  } else {
    toast((res && res.error) || "导入失败", "err");
  }
  await refreshPlugins();
}

function bindDropImport() {
  window.addEventListener("dragenter", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dropDepth += 1;
    document.body.classList.add("dragging");
  });

  window.addEventListener("dragover", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  });

  // dragleave 会在子元素之间反复触发，用深度计数避免提示一闪一闪
  window.addEventListener("dragleave", (e) => {
    if (!hasFiles(e)) return;
    dropDepth = Math.max(0, dropDepth - 1);
    if (!dropDepth) document.body.classList.remove("dragging");
  });

  window.addEventListener("drop", async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); // 不加这句，WebView2 会把文件当导航打开
    dropDepth = 0;
    document.body.classList.remove("dragging");
    try {
      await importDropped(e.dataTransfer);
    } catch (err) {
      toast(`导入失败：${err.message}`, "err");
    }
  });
}

/* ---------------------------------------------------------- 插件加载 */
function injectPluginCss(id, css) {
  if (!css) return;
  let tag = document.getElementById(`plugin-css-${id}`);
  if (!tag) {
    tag = document.createElement("style");
    tag.id = `plugin-css-${id}`;
    document.head.appendChild(tag);
  }
  tag.textContent = css;
}

const FBM = {
  _defs: [],
  registerPlugin(def) {
    if (!def || !def.id) return;
    FBM._defs.push(def);
  },
  api: (name, ...args) => bridge.call(name, ...args),
  pluginCall: (pid, method, payload) => bridge.call("plugin_call", pid, method, payload),
  toast,
  el(tag, className, text) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text != null) n.textContent = text;
    return n;
  },
};
window.FBM = FBM;

function buildPluginNav(defs) {
  const nav = $("#pluginNav");
  const pages = $("#pluginPages");
  nav.innerHTML = "";
  pages.querySelectorAll("[data-plugin-page]").forEach((n) => n.remove());

  for (const def of defs) {
    if (!def.tab) continue;
    const btn = document.createElement("button");
    btn.className = "nav-item";
    btn.dataset.page = `plugin:${def.id}`;
    btn.innerHTML = `<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="4.2"/><path d="M8 1.6v2M8 12.4v2M1.6 8h2M12.4 8h2"/></svg><span>${esc(def.tab.title || def.name || def.id)}</span>`;
    btn.addEventListener("click", () => go(`plugin:${def.id}`));
    nav.appendChild(btn);

    const section = document.createElement("section");
    section.className = "page";
    section.dataset.page = `plugin:${def.id}`;
    section.dataset.pluginPage = def.id;
    section.innerHTML = `<div class="page-head"><div><h1>${esc(def.tab.title || def.name || def.id)}</h1><p class="muted">插件 ${esc(def.id)}</p></div></div><div class="plugin-body"></div>`;
    pages.appendChild(section);
  }
}

function mountPlugin(def) {
  if (def.__mounted) return;
  const section = document.querySelector(`[data-plugin-page="${def.id}"]`);
  if (!section) return;
  const body = $(".plugin-body", section);
  try {
    def.mount && def.mount(body, {
      api: bridge.call,
      pluginCall: (method, payload) => bridge.call("plugin_call", def.id, method, payload),
      toast,
      state,
      el: FBM.el,
    });
    def.__mounted = true;
  } catch (err) {
    body.innerHTML = `<div class="card"><div class="empty">插件挂载失败：${esc(err.message)}</div></div>`;
  }
}

async function loadPluginUi() {
  FBM._defs = [];
  const payload = (await bridge.call("plugin_ui")) || [];

  // 插件被移除或停用后，它注入的 <style> 要跟着走，否则会一直污染界面
  const alive = new Set(payload.map((item) => `plugin-css-${item.id}`));
  document.querySelectorAll('style[id^="plugin-css-"]').forEach((tag) => {
    if (!alive.has(tag.id)) tag.remove();
  });

  for (const item of payload) {
    try {
      injectPluginCss(item.id, item.css);
      // 用 Function 执行，绕开 file:// 下 <script src> 的跨域限制
      new Function("FBM", item.js)(FBM);
    } catch (err) {
      toast(`插件 ${item.id} 加载失败：${err.message}`, "err");
    }
  }
  state.pluginDefs = FBM._defs;
  buildPluginNav(state.pluginDefs);
  if (state.page.startsWith("plugin:")) {
    const def = state.pluginDefs.find((d) => `plugin:${d.id}` === state.page);
    if (def) mountPlugin(def);
    else go("plugins"); // 正停在被卸掉的插件页时，退回插件列表
  }
}

/* ---------------------------------------------------------- 轮询 */
let polling = false;
async function tick() {
  if (polling) return;
  polling = true;
  try {
    const [status, logs] = await Promise.all([bridge.call("get_status"), bridge.call("get_logs", state.lastId)]);
    if (status) {
      const wasRunning = state.status.running;
      state.status = status;
      renderStatus();
      if (wasRunning !== status.running) {
        $("#chipUptime").textContent = `运行 ${fmtUptime(status.uptime || 0)}`;
        state.preflight = await bridge.call("get_preflight");
        renderStatus();
      } else if (status.running) {
        $("#chipUptime").textContent = `运行 ${fmtUptime(status.uptime || 0)}`;
      }
    }
    appendLogs(logs);
  } catch (err) {
    console.warn(err);
  } finally {
    polling = false;
  }
}

/* ---------------------------------------------------------- 事件绑定 */
const HELP_DOCS = "https://open.feishu.cn/document/";

function openHelp() {
  const m = $("#helpModal");
  if (!m) return;
  m.classList.add("show");
  m.setAttribute("aria-hidden", "false");
  const ok = $("#helpOk");
  if (ok) ok.focus();
}

function closeHelp() {
  const m = $("#helpModal");
  if (!m) return;
  m.classList.remove("show");
  m.setAttribute("aria-hidden", "true");
}

function bindHelp() {
  const m = $("#helpModal");
  if (!m) return;
  const close = $("#helpClose");
  if (close) close.addEventListener("click", closeHelp);
  const ok = $("#helpOk");
  if (ok) ok.addEventListener("click", closeHelp);
  m.addEventListener("click", (e) => {
    if (e.target === m) closeHelp();
  });
  // 弹窗里的链接一律交给系统浏览器，避免把容器页面导航走
  m.addEventListener("click", async (e) => {
    const a = e.target.closest("a[data-ext]");
    if (!a) return;
    e.preventDefault();
    await bridge.call("open_url", a.href).catch(() => toast("打不开链接", "err"));
  });
  const docs = $("#helpDocs");
  if (docs)
    docs.addEventListener("click", async () => {
      const r = await bridge.call("open_url", HELP_DOCS).catch((err) => ({ ok: false, error: String(err.message || err) }));
      if (!r) toast("打不开官方文档", "err");
    });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && m.classList.contains("show")) closeHelp();
  });
}

function bindEvents() {
  bindHelp();
  // 窗口按钮
  $$("[data-win]").forEach((b) =>
    b.addEventListener("click", () => {
      const kind = b.dataset.win;
      if (kind === "min") bridge.call("win_minimize");
      else if (kind === "max") bridge.call("win_toggle_max");
      else if (kind === "close") {
        const quitting = ((state.cfg.window || {}).closeAction || "tray") === "quit";
        bridge.call("win_hide");
        if (!quitting) toast("已收进托盘，点托盘图标可以回来", "warn");
      }
    }),
  );

  // 标题栏拖拽
  const bar = $("#titlebar");
  bar.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    if (e.target.closest(".no-drag") || e.target.closest(".winbtn")) return;
    bridge.call("win_drag");
  });
  bar.addEventListener("dblclick", (e) => {
    if (e.target.closest(".no-drag")) return;
    bridge.call("win_toggle_max");
  });

  // 贴边拖拽改大小：热区把方向交给后端，真正的缩放由系统接管
  $$("#resizeLayer [data-resize]").forEach((zone) =>
    zone.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      bridge.call("win_resize", zone.dataset.resize);
    }),
  );

  // 拖入插件安装
  bindDropImport();

  // 导航
  $$(".nav-item[data-page]").forEach((b) => b.addEventListener("click", () => go(b.dataset.page)));
  $$("[data-goto]").forEach((b) => b.addEventListener("click", () => go(b.dataset.goto)));

  // 概览
  $("#btnStart").addEventListener("click", async () => {
    const r = await bridge.call("start_bot");
    if (r && r.ok) toast("机器人已启动");
    else toast((r && r.message) || "启动失败", "err");
    tick();
  });
  $("#btnStop").addEventListener("click", async () => {
    const r = await bridge.call("stop_bot");
    toast(r && r.ok ? "已停止" : (r && r.message) || "停止失败", r && r.ok ? "ok" : "err");
    tick();
  });
  $("#btnRestart").addEventListener("click", async () => {
    const r = await bridge.call("restart_bot");
    toast(r && r.ok ? "已重启" : (r && r.message) || "重启失败", r && r.ok ? "ok" : "err");
    tick();
  });
  $("#btnRevealDir").addEventListener("click", () => bridge.call("open_path", state.status.botDir || ""));
  $("#btnRecheck").addEventListener("click", async () => {
    state.preflight = await bridge.call("get_preflight");
    renderStatus();
    toast(state.preflight && state.preflight.ok ? "体检通过" : "有问题需要处理", state.preflight && state.preflight.ok ? "ok" : "warn");
  });

  // 配置
  $("#btnExportCfg").addEventListener("click", async () => {
    const r = await bridge.call("export_config");
    if (r && r.ok) toast(`已导出 ${r.count} 项配置`);
    else if (r && r.canceled) return;
    else toast((r && r.error) || "导出失败", "err");
  });
  $("#btnImportCfg").addEventListener("click", async () => {
    const r = await bridge.call("import_config");
    if (r && r.ok) {
      await Promise.all([loadEnv(), loadDocs()]);
      toast(`已导入 ${r.count} 项配置${r.docs ? "（含 docs.json）" : ""}`);
    } else if (r && r.canceled) return;
    else toast((r && r.error) || "导入失败", "err");
  });
  $("#btnReloadEnv").addEventListener("click", async () => {
    await loadEnv();
    toast("已重新读取 .env");
  });
  $("#btnSaveEnv").addEventListener("click", async () => {
    const r = await bridge.call("save_env", collectEnv());
    if (r && r.ok) {
      toast("配置已保存");
      $("#envRaw").value = (await bridge.call("get_env")).raw || "";
    } else toast((r && r.error) || "保存失败", "err");
  });
  $("#btnSaveDocs").addEventListener("click", async () => {
    const r = await bridge.call("save_docs", $("#docsEditor").value);
    if (r && r.ok) {
      toast("docs.json 已保存");
      await loadDocs();
    } else toast((r && r.error) || "保存失败", "err");
  });

  const addDoc = async () => {
    const url = $("#docUrl").value.trim();
    if (!url) return toast("先把文档链接粘进来", "warn");
    const r = await bridge.call("add_doc", url, $("#docName").value.trim(), true);
    if (r && r.ok) {
      $("#docUrl").value = "";
      $("#docName").value = "";
      renderDocList(r.docs || []);
      const info = await bridge.call("get_docs");
      if (info && info.ok) $("#docsEditor").value = info.raw || "";
      $("#docsPath").textContent = `${(r.docs || []).length} 篇 · ${r.path || ""}`;
      if (r.hint) toast(r.hint, r.supported ? "ok" : "warn");
      else toast("已添加到文档清单");
    } else toast((r && r.error) || "添加失败", "err");
  };
  $("#btnAddDoc").addEventListener("click", addDoc);
  $("#docUrl").addEventListener("keydown", (e) => {
    if (e.key === "Enter") addDoc();
  });
  $("#docName").addEventListener("keydown", (e) => {
    if (e.key === "Enter") addDoc();
  });
  $("#btnSaveEnvRaw").addEventListener("click", async () => {
    const r = await bridge.call("save_env_raw", $("#envRaw").value);
    if (r && r.ok) {
      toast(".env 原文已保存");
      await loadEnv();
    } else toast((r && r.error) || "保存失败", "err");
  });

  // 日志
  $("#logSearch").addEventListener("input", (e) => {
    state.search = e.target.value.trim().toLowerCase();
    renderLogs();
  });
  $$("#logFilter .chip-btn").forEach((b) =>
    b.addEventListener("click", () => {
      state.level = b.dataset.level;
      $$("#logFilter .chip-btn").forEach((x) => x.classList.toggle("active", x === b));
      renderLogs();
    }),
  );
  $("#chkAutoScroll").addEventListener("change", (e) => {
    state.autoscroll = e.target.checked;
    if (state.autoscroll) $("#logView").scrollTop = $("#logView").scrollHeight;
  });
  $("#btnClearLogs").addEventListener("click", async () => {
    await bridge.call("clear_logs");
    state.logs = [];
    state.lastId = 0;
    renderLogs();
    toast("日志已清空");
  });
  $("#btnExportLogs").addEventListener("click", async () => {
    const r = await bridge.call("export_logs");
    if (r && r.ok) toast(`已导出到 ${r.path}`);
    else toast("导出失败", "err");
  });

  // 插件
  $("#btnOpenPlugins").addEventListener("click", () => bridge.call("open_plugins_dir"));
  $("#btnReloadPlugins").addEventListener("click", async () => {
    await bridge.call("reload_plugins");
    await refreshPlugins();
    toast("插件已重新加载");
  });

  // 设置
  $$("#themeSeg button").forEach((b) =>
    b.addEventListener("click", async () => {
      document.documentElement.dataset.theme = b.dataset.theme;
      $$("#themeSeg button").forEach((x) => x.classList.toggle("active", x === b));
      await bridge.call("set_ui", { theme: b.dataset.theme });
    }),
  );
  $$("#closeSeg button").forEach((b) =>
    b.addEventListener("click", async () => {
      const action = b.dataset.close === "quit" ? "quit" : "tray";
      await bridge.call("set_close_action", action);
      state.cfg.window = state.cfg.window || {};
      state.cfg.window.closeAction = action;
      $$("#closeSeg button").forEach((x) => x.classList.toggle("active", x === b));
      toast(action === "quit" ? "以后点 × 会直接退出应用" : "以后点 × 会收进托盘，机器人继续跑", "ok");
    }),
  );
  $$("#frameSeg button").forEach((b) =>
    b.addEventListener("click", async () => {
      const frameless = b.dataset.frameless === "1";
      await bridge.call("save_settings", { window: { frameless } });
      $$("#frameSeg button").forEach((x) => x.classList.toggle("active", x === b));
      toast(frameless ? "已设为无边框，重启管家后生效" : "已设为系统标题栏，重启管家后生效", "warn");
    }),
  );

  $("#chkAutostart").addEventListener("change", async (e) => {
    const r = await bridge.call("set_autostart", e.target.checked);
    toast(r && r.ok ? (e.target.checked ? "已设置开机自启" : "已取消开机自启") : "设置失败，可能被安全软件拦了", r && r.ok ? "ok" : "err");
  });
  $("#chkAutoStartBot").addEventListener("change", async (e) => {
    await bridge.call("save_settings", { bot: { autoStart: e.target.checked } });
    toast(e.target.checked ? "下次打开管家会自动启动机器人" : "已关闭自动启动");
  });
  $("#chkStopOnExit").addEventListener("change", async (e) => {
    await bridge.call("save_settings", { bot: { stopOnExit: e.target.checked } });
    toast("设置已保存");
  });
  $("#btnPickDir").addEventListener("click", async () => {
    const dir = await bridge.call("pick_folder");
    if (dir) {
      $("#inpBotDir").value = dir;
      await bridge.call("save_settings", { bot: { dir } });
      toast("目录已更新");
      state.preflight = await bridge.call("get_preflight");
      state.status = await bridge.call("get_status");
      renderStatus();
    }
  });
  $("#btnUseBundled").addEventListener("click", async () => {
    const r = await bridge.call("use_bundled_bot").catch((err) => ({ ok: false, error: String((err && err.message) || err) }));
    if (!r || !r.ok) {
      toast((r && r.error) || "这一版没有内置机器人", "err");
      return;
    }
    $("#inpBotDir").value = r.dir;
    state.cfg.bot = state.cfg.bot || {};
    state.cfg.bot.dir = r.dir;
    state.preflight = await bridge.call("get_preflight");
    state.status = await bridge.call("get_status");
    renderStatus();
    toast("已切到安装目录里自带的机器人，回「概览」点启动");
  });

  $("#btnSavePaths").addEventListener("click", async () => {    await bridge.call("save_settings", { bot: { dir: $("#inpBotDir").value.trim(), node: $("#inpNode").value.trim() } });
    state.preflight = await bridge.call("get_preflight");
    state.status = await bridge.call("get_status");
    renderStatus();
    toast("路径已保存");
  });

  $("#btnQuit").addEventListener("click", async () => {
    await bridge.call("quit_app");
  });

  // 快捷键
  window.addEventListener("keydown", (e) => {
    if (!e.ctrlKey) return;
    const map = { 1: "overview", 2: "config", 3: "logs", 4: "plugins", 5: "settings" };
    if (map[e.key]) {
      e.preventDefault();
      go(map[e.key]);
    }
  });
}

/* ---------------------------------------------------------- 启动 */
function hideBoot() {
  const boot = $("#boot");
  if (!boot) return;
  boot.classList.add("gone");
  setTimeout(() => boot.remove(), 360);
}

function showFirstRunHint() {
  const page = document.querySelector('.page[data-page="overview"]');
  if (!page || document.getElementById("firstRunHint")) return;
  const bar = document.createElement("div");
  bar.className = "notice";
  bar.id = "firstRunHint";
  bar.innerHTML = `
    <div class="notice-main">
      <b>还差一步：选机器人目录</b>
      <span>安装包自带一份机器人（安装目录下的 <code>bot</code> 子目录）。想用你自己的 <code>feishu-deepseek-bot</code>，在设置里选过来即可。</span>
    </div>
    <div class="notice-actions">
      <button class="btn" id="hintDismiss" type="button">知道了</button>
      <button class="btn primary" id="hintGoSettings" type="button">去设置</button>
    </div>`;
  page.prepend(bar);
  const goBtn = bar.querySelector("#hintGoSettings");
  if (goBtn) goBtn.addEventListener("click", () => go("settings"));
  const closeBtn = bar.querySelector("#hintDismiss");
  if (closeBtn) closeBtn.addEventListener("click", () => bar.remove());
}

async function boot() {
  let data;
  try {
    data = await bridge.call("bootstrap");
  } catch (err) {
    hideBoot();
    toast(`后端没接上：${err.message}`, "err");
    return;
  }
  if (!data) {
    hideBoot();
    toast("无法连接后端", "err");
    return;
  }
  state.cfg = data.config;
  state.status = data.status;
  state.preflight = data.preflight;
  state.plugins = data.plugins || [];
  state.envFields = data.envFields || [];
  state.animations = data.animations || window.ANIM_PRESETS;

  window.applyAnimation((data.config.ui && data.config.ui.animation) || "smooth");
  document.documentElement.dataset.theme = (data.config.ui && data.config.ui.theme) || "dark";

  $("#aboutName").textContent = data.app.name;
  $("#aboutVer").textContent = `v${data.app.version} · Python ${data.platform.py}${data.app.frozen ? " · 打包版" : " · 开发模式"}`;
  $("#inpBotDir").value = (data.config.bot && data.config.bot.dir) || "";
  $("#inpNode").value = (data.config.bot && data.config.bot.node) || "node";
  $("#chkAutostart").checked = !!data.autostart;
  $("#chkAutoStartBot").checked = !!(data.config.bot && data.config.bot.autoStart);
  $("#chkStopOnExit").checked = !!(data.config.bot && data.config.bot.stopOnExit);
  const framelessNow = !(data.config.window && data.config.window.frameless === false);
  $$("#frameSeg button").forEach((b) =>
    b.classList.toggle("active", (b.dataset.frameless === "1") === framelessNow),
  );
  const closeNow = (data.config.window && data.config.window.closeAction) || "tray";
  $$("#closeSeg button").forEach((b) =>
    b.classList.toggle("active", b.dataset.close === closeNow),
  );

  renderStatus();
  renderSettings();
  renderPlugins();
  bindEvents();

  await Promise.all([loadEnv(), loadDocs(), loadPluginUi()]);
  state.logs = (await bridge.call("get_logs", 0)) || [];
  if (state.logs.length) state.lastId = state.logs[state.logs.length - 1].id;
  renderLogs();

  setInterval(tick, 1000);
  tick();
  hideBoot();

  // 调试用：?page=config 可以直接打开某页
  const want = new URLSearchParams(location.search).get("page");
  if (want && document.querySelector(`.page[data-page="${want}"]`)) {
    go(want);
  } else if (!(state.cfg.bot && state.cfg.bot.dir)) {
    // 首次使用：停在概览，用一条提示把人引到设置，而不是把首页换掉
    showFirstRunHint();
    toast("还没设置机器人目录，先选一下再点启动", "warn");
  }
  window.__fbm = state;
  window.__bootMs = Math.round(performance.now());
}

window.addEventListener("error", (e) => {
  window.__jsError = `${e.message} @ ${e.filename}:${e.lineno}`;
});

document.addEventListener("DOMContentLoaded", boot);
