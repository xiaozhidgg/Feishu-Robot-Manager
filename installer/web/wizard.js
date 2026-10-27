/* 安装向导逻辑 */
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const state = { step: "welcome", path: "", info: {}, timer: null, lastText: "" };

/* 浏览器里直接打开预览用的假数据 */
const MOCK = {
  info: () => ({
    name: "飞书机器人管家",
    version: "1.0.0",
    defaultDir: "C:\\Users\\you\\AppData\\Local\\Programs\\FeishuBotManager",
    needMB: 16,
    freeMB: 128_000,
    installed: { found: true, path: "C:\\Users\\you\\AppData\\Local\\Programs\\FeishuBotManager", version: "1.0.0", source: "registry" },
    running: false,
  }),
  status: () => ({ needMB: 16, freeMB: 128_000, installed: false, writable: true, error: "" }),
  browse: () => null,
  start: () => ({ ok: true }),
  progress: () => ({ running: false, pct: 100, text: "完成", done: true, error: "", target: "" }),
  open_app: () => true,
  close: () => {},
};

/* ---------------- 桥 ---------------- */
const bridge = (() => {
  function wait(name, timeout = 8000) {
    const has = () => window.pywebview && window.pywebview.api && typeof window.pywebview.api[name] === "function";
    if (has()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const t0 = Date.now();
      const t = setInterval(() => {
        if (has()) { clearInterval(t); resolve(true); }
        else if (Date.now() - t0 > timeout) { clearInterval(t); resolve(false); }
      }, 60);
    });
  }
  return {
    async call(name, ...args) {
      const ready = await wait(name, "pywebview" in window ? 8000 : 300);
      if (ready && window.pywebview && window.pywebview.api) {
        return window.pywebview.api[name](...args);
      }
      if (!("pywebview" in window)) {
        const mock = MOCK[name];
        return mock ? mock(...args) : null;
      }
      throw new Error("安装程序后端未就绪");
    },
  };
})();

/* ---------------- 步骤切换 ---------------- */
function setStep(step) {
  state.step = step;
  $$(".step").forEach((s) => s.classList.toggle("active", s.dataset.step === step));

  const names = { welcome: "安装向导", location: "选择安装位置", progress: "正在安装", done: "完成" };
  $("#stepName").textContent = names[step] || "";

  const back = $("#btnBack");
  const next = $("#btnNext");
  const cancel = $("#btnCancel");
  back.classList.toggle("hide", step === "welcome" || step === "progress");
  cancel.classList.toggle("hide", step === "progress");

  if (step === "welcome") {
    next.textContent = "下一步";
    next.disabled = false;
    $("#footHint").textContent = "点击「下一步」开始";
  } else if (step === "location") {
    next.textContent = state.running ? "管家运行中" : "安装";
    next.disabled = !!state.running;
    $("#footHint").textContent = "确认位置后点「安装」";
    setTimeout(() => $("#pathInput").focus(), 60);
  } else if (step === "progress") {
    next.textContent = "安装中…";
    next.disabled = true;
    $("#footHint").textContent = "正在写入文件，请稍候";
  } else if (step === "done") {
    next.textContent = "完成";
    next.disabled = false;
    $("#footHint").textContent = "";
  }
}

/* ---------------- 路径校验 ---------------- */
const APP_SUBDIR = "FeishuBotManager";
// 用户选的是父目录（例如 D:\software），真正落盘位置要再补一层软件文件夹；
// 与 installer/core.py:resolve_target() 保持同一套规则（后端为准，这里只做展示）。
function resolveDir(raw) {
  const t = String(raw).trim().replace(/[\\/]+$/, "");
  if (!t) return "";
  const base = t.split(/[\\/]/).pop().toLowerCase();
  if (base === APP_SUBDIR.toLowerCase() || base === "飞书机器人管家") return t;
  return t + "\\" + APP_SUBDIR;
}
let hintTimer = null;
async function checkPath() {
  if (state.running) {
    setHint("管家正在运行，请先从托盘退出，再点安装", "err");
    return null;
  }
  const path = $("#pathInput").value.trim();
  if (!path) {
    setHint("安装位置不能为空", "err");
    return null;
  }
  const target = resolveDir(path);
  try {
    const st = await bridge.call("status", path);
    if (!st.writable) {
      setHint(st.error || "这个位置不能写", "err");
    } else if (st.installed) {
      setHint(`会装到 ${target}（这里已经装过一版，覆盖程序文件、保留 plugins）· 剩余 ${st.freeMB} MB`, "warn");
    } else {
      setHint(`会装到 ${target} · 需要约 ${st.needMB} MB，该盘剩余 ${st.freeMB} MB`, "ok");
    }
    return st;
  } catch (err) {
    setHint(String(err.message || err), "err");
    return null;
  }
}

function setHint(text, kind) {
  const el = $("#pathHint");
  el.textContent = text;
  el.className = "hint" + (kind ? " " + kind : "");
}

/* ---------------- 安装 ---------------- */
async function doInstall() {
  const path = $("#pathInput").value.trim();
  if (!path) {
    setHint("安装位置不能为空", "err");
    return;
  }
  $("#logList").innerHTML = "";
  state.lastText = "";
  $("#barFill").style.width = "0%";
  $("#pctText").textContent = "0%";
  $("#progressText").textContent = "准备中…";
  setStep("progress");

  try {
    const res = await bridge.call("start", path, {
      desktop: $("#optDesktop").checked,
      startMenu: $("#optStartMenu").checked,
      registry: true,
    });
    if (!res || !res.ok) throw new Error((res && res.error) || "启动安装失败");
  } catch (err) {
    showResult(false, String(err.message || err), path);
    return;
  }

  state.timer = setInterval(poll, 140);
}

async function poll() {
  let p;
  try {
    p = await bridge.call("progress");
  } catch (err) {
    clearInterval(state.timer);
    showResult(false, String(err.message || err), $("#pathInput").value.trim());
    return;
  }
  if (!p) return;

  $("#barFill").style.width = `${p.pct || 0}%`;
  $("#pctText").textContent = `${p.pct || 0}%`;
  if (p.text) {
    $("#progressText").textContent = p.text;
    if (p.text !== state.lastText) {
      state.lastText = p.text;
      const line = document.createElement("div");
      line.textContent = `${String(p.pct || 0).padStart(3, " ")}%  ${p.text}`;
      $("#logList").appendChild(line);
      $("#logList").scrollTop = $("#logList").scrollHeight;
    }
  }

  if (p.done) {
    clearInterval(state.timer);
    if (p.error) showResult(false, p.error, p.target);
    else showResult(true, "", p.target);
  }
}

function showResult(ok, message, target) {
  $("#doneOk").classList.toggle("show", ok);
  $("#doneErr").classList.toggle("show", !ok);
  if (ok) {
    $("#installedPath").textContent = target || "";
  } else {
    $("#errText").textContent = message || "未知错误";
  }
  setStep("done");
}

/* ---------------- 事件 ---------------- */
function bind() {
  $("#btnNext").addEventListener("click", async () => {
    if (state.step === "welcome") {
      setStep("location");
    } else if (state.step === "location") {
      await doInstall();
    } else if (state.step === "done") {
      if ($("#doneOk").classList.contains("show") && $("#optRun").checked) {
        await bridge.call("open_app", $("#installedPath").textContent).catch(() => {});
      }
      await bridge.call("close").catch(() => {});
    }
  });

  $("#btnBack").addEventListener("click", () => setStep("welcome"));
  $("#btnCancel").addEventListener("click", async () => {
    await bridge.call("close").catch(() => {});
  });

  $("#btnBrowse").addEventListener("click", async () => {
    const picked = await bridge.call("browse", $("#pathInput").value.trim()).catch(() => null);
    if (picked) {
      $("#pathInput").value = picked;
      checkPath();
    }
  });

  $("#pathInput").addEventListener("input", () => {
    clearTimeout(hintTimer);
    hintTimer = setTimeout(checkPath, 350);
  });
  $("#pathInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && state.step === "location") doInstall();
  });

  // 输入框里允许选中复制
  $$("input").forEach((i) => i.addEventListener("mousedown", () => document.body.classList.add("selecting")));
}

/* ---------------- 启动 ---------------- */
async function boot() {
  bind();
  try {
    const info = await bridge.call("info");
    state.info = info || {};
    $("#verText").textContent = `v${info.version || "1.0.0"}`;
    $("#needMB").textContent = info.needMB || "16";
    $("#pathInput").value = info.defaultDir || "";
    state.path = info.defaultDir || "";
    state.installed = info.installed || { found: false };
    state.running = !!info.running;
    if (state.installed.found) {
      // 装过就默认覆盖到原位置，并在向导里说清楚
      $("#pathInput").value = state.installed.path;
      state.path = state.installed.path;
      setHint(
        `检测到已安装${state.installed.version ? " v" + state.installed.version : ""}：${state.installed.path}，将覆盖安装（保留 plugins 与你改过的 bot）`,
        "warn",
      );
    }
    if (state.running) {
      setHint("管家正在运行，请先从托盘退出，再点安装", "err");
    }
    await checkPath();
  } catch (err) {
    setHint(`无法连接安装后端：${err.message}`, "err");
  }
  const want = new URLSearchParams(location.search).get("step");
  setStep(want && ["welcome", "location", "progress", "done"].includes(want) ? want : "welcome");
  if (want === "done") showResult(true, "", "C:\\Users\\you\\AppData\\Local\\Programs\\FeishuBotManager");
}

document.addEventListener("DOMContentLoaded", boot);
