# 飞书机器人管家 · 开发者文档

> 版本 **1.0.1** ｜ 平台 **Windows 10/11** ｜ 运行时 **Python 3.11+ · WebView2**
>
> 本文档面向二次开发与维护者。只想把机器人跑起来的终端用户，读「[快速开始](#2-快速开始)」一节即可。

飞书机器人管家（FeishuBotManager）是一个单文件桌面工具，把飞书 DeepSeek 机器人的**启停、配置、日志、插件**收进一个窗口：GUI 用 WebView2 渲染，后端用 Python 托管子进程，打包成一个 exe，目标机器不需要装 Python。

**核心特性**

| 能力 | 实现方式 |
|---|---|
| 单文件分发 | PyInstaller `--onefile`，界面资源打进包内，约 15 MB（安装包约 31 MB） |
| 现代化界面 | pywebview + Edge WebView2，无边框窗口，纯 DOM 无前端框架 |
| 机器人托管 | `subprocess` 拉起 `node index.js`，stdout/stderr 实时汇入日志 |
| 配置编辑 | 图形化编辑机器人 `.env`（保留注释）与 `docs.json`（带链接解析） |
| 日志 | 内存环形缓冲 + 按天落盘，14 天自动清理 |
| 插件系统 | 目录即插件，前后端双端扩展，热重载免重新打包 |
| 系统集成 | 托盘常驻、开机自启（HKCU，免管理员）、卸载项注册 |
| 交付 | 自带安装向导（图形/静默）；卸载由主程序 `--uninstall` 完成，不再附带独立的卸载 exe |

---

## 目录

1. [项目概览](#1-项目概览)
2. [快速开始](#2-快速开始)
3. [界面与交互](#3-界面与交互)
4. [架构](#4-架构)
5. [开发环境](#5-开发环境)
6. [前后端 IPC 接口参考](#6-前后端-ipc-接口参考)
7. [插件开发](#7-插件开发)
8. [运行时文件与配置格式](#8-运行时文件与配置格式)
9. [构建与发布](#9-构建与发布)
10. [测试与自检](#10-测试与自检)
11. [故障排查](#11-故障排查)
12. [已知限制与维护约定](#12-已知限制与维护约定)

---

## 1. 项目概览

管家本身**不实现**任何机器人业务逻辑。它只做四件事：

1. **托管进程** —— 在机器人目录里启动/停止 `node index.js`，把输出接进日志；
2. **编辑配置** —— 用图形界面读写机器人目录下的 `.env`、`docs.json`；
3. **观测** —— 状态灯、运行时长、退出码、启动前体检、实时日志；
4. **扩展** —— 加载 `plugins\` 下的第三方插件，给界面加页、给后端加方法。

被托管的机器人（`feishu-deepseek-bot`）是独立项目，开发时位于本仓库的**同级目录**，有自己的 README；本仓库的 `bot/` 是它的**源码快照**（随发布一起打进入安装包，`node_modules`、`.env`、`docs.json` 不入库）。两者只通过「机器人目录」这一个路径约定耦合。

---

## 2. 快速开始

1. 双击 `FeishuBotManager.exe`（安装版在开始菜单/桌面，绿色版就在项目根目录）。
2. 首次启动会自动猜测机器人目录：**先看安装目录下的 `bot\`**（安装包自带的那份），再看 exe 同级的 `feishu-deepseek-bot\`，再向上找兄弟目录，最后看桌面/下载/文档。想换成自己的项目，去 **设置 → 运行环境** 点「选择」，或直接点「用自带的」切回内置副本。一个都没猜到时首页仍然是**概览**，只在页顶多一条提示「还差一步：选机器人目录」，启动前体检也只报一条明确错误，不会拿安装目录误当机器人目录。
3. **概览** 页点「启动」，状态灯变绿即启动成功；启动失败时「体检」卡片会列出具体原因（目录不存在 / 缺 `index.js` / 找不到 Node / 缺 `.env`）。
4. 关闭窗口**不会退出**，会缩到右下角托盘；彻底退出走托盘菜单「退出」或 **设置 → 退出管家**。

> 同一时间只允许一个实例运行（互斥体 `Global\FeishuBotManager_SingleInstance`）。重复双击时新进程会直接退出，请检查托盘。

---

## 3. 界面与交互

左侧五个导航入口，`Ctrl+1..5` 切换：

| 页面 | 快捷键 | 职责 |
|---|---|---|
| **概览** | `Ctrl+1` | 状态灯、PID、运行时长、启动/停止/重启、启动前体检、最近输出；首次运行且未设机器人目录时，页顶多一条「还差一步」提示条（去设置 / 知道了） |
| **机器人配置** | `Ctrl+2` | 图形化编辑 `.env`（分组表单）、`docs.json` 清单、原始文本编辑器。`App ID` / `App Secret` 行尾有两枚小按钮：「配置说明」弹窗给出飞书后台 6 步配置引导，「↗ 开放平台」直达该应用的凭证页 |
| **运行日志** | `Ctrl+3` | 实时滚动、级别过滤、关键词搜索、自动滚动、导出、清空 |
| **插件** | `Ctrl+4` | 列出已装插件、启用/停用、打开插件目录、重新加载、**拖入文件夹或 .zip 直接安装** |
| **设置** | `Ctrl+5` | 动画预设、主题、关闭窗口行为（托盘/退出）、开机自启、路径、窗口边框、退出 |

### 3.1 飞书应用配置引导

`机器人配置 → 飞书 App ID` 标签行尾的「配置说明」是一个应用内弹窗（`#helpModal`，`app/web/index.html`），把飞书后台的配置顺序写成 6 步：

1. 开放平台创建企业自建应用；
2. 「凭证与基础信息」取 `App ID` / `App Secret` 填回本页；
3. 「添加应用能力」勾选机器人；
4. 「权限管理」开通「获取与发送单聊、群组消息」「接收群聊中 @ 机器人消息」；
5. 「事件与回调」订阅方式选**长连接**，添加事件 `im.message.receive_v1`；
6. 「版本管理与发布」创建版本、申请发布，管理员通过后把机器人拉进群。

弹窗底部两枚按钮：「官方文档」→ `https://open.feishu.cn/document/`；「知道了」/`Esc`/点遮罩关闭。旁边的「↗ 开放平台」按当前 `App ID` 直达 `https://open.feishu.cn/app/<app_id>/baseinfo`，未填或格式非法时回退到应用列表。弹窗内的链接统一交给系统浏览器打开（`a[data-ext]` 拦截 + `open_url`），不会把 WebView2 导航走。

### 3.2 动画

四种预设存于 `manager.config.json → ui.animation`，切换后立即重放当前页面动画：

| id | 名称 | 表现 |
|---|---|---|
| `smooth` | 丝滑淡入（默认） | 8px 上浮 + 柔和缓动 |
| `spring` | 弹性回弹 | 带轻微 overshoot |
| `glass` | 玻璃柔光 | 毛玻璃面板 + 背景柔光 |
| `none` | 极简零动画 | 全部瞬时切换 |

预设清单由后端 `app/api.py` 的 `ANIMATIONS` 常量提供，前端把 `<body data-anim>` 交给 `app/web/js/animations.js` 驱动。**新增预设需同时改这两处。**

### 3.3 无边框窗口与四周缩放

`window.frameless=true` 时标题栏是自绘的，拖动由 `win_drag()` 完成：后端在 UI 线程里调用

```python
user32.ReleaseCapture()
user32.SendMessageW(hwnd, 0xA1, 0x2, 0)   # WM_NCLBUTTONDOWN / HTCAPTION
```

把拖动交还给系统窗口管理器，因此保留原生贴边、双击最大化行为。少数缩放比例或多屏环境下手感异常时，可在 **设置 → 窗口边框** 切回系统标题栏（需重启生效）。

**四周缩放**：无边框窗口没有系统边框，界面上叠了一层 8 个透明热区（`#resizeLayer` 里的 `[data-resize]`，边 4–5px、角 12px）。鼠标按下时前端把方向（`left` / `right` / `top` / `bottom` / `topleft` / `topright` / `bottomleft` / `bottomright`）交给 `win_resize(edge)`，后端换算成 Win32 命中测试码（`HTLEFT`=10 … `HTBOTTOMRIGHT`=17）后，同样走 `ReleaseCapture` + `WM_NCLBUTTONDOWN`，由系统接管整段缩放过程，所以拖动是跟手的、不经过 Python 循环。

最大化状态下拖边或拖角，会先自动还原成普通窗口再开始缩放；拖动结束后大小会写入 `manager.config.json` 的 `window.width/height`，下次启动沿用（最大化尺寸不记录）。

### 3.4 问答日志（可折叠）

机器人被管家拉起时，`BotProcess.start()` 会注入 `FBM_MANAGED=1`；机器人据此把「谁问了什么 / 正在思考 / 最终回复」以 `\x1eFBM {json}` 的形式打到 stdout（`MSG_PREFIX`，见 `app/core/process.py`）。读线程识别前缀后**不再当普通输出**，而是转成一条带 `kind` 的日志：

| kind | 界面显示 | 明细 |
| --- | --- | --- |
| `ask` | `🙋 提问：<前 60 字>` | 完整提问 |
| `think` | `🤔 思考中（deepseek-flash）` | 无 |
| `reply` | `💬 回复（N 字）` | 完整回复 |

带明细的行默认**折起**，点一下展开全文（`<details class="log-fold">`，摘要行右侧有「展开 / 收起」小胶囊）。关键取舍：**明细只留在内存里**（`LogStore.add(..., detail=...)`），`logs\manager-YYYY-MM-DD.log` 只写摘要行 —— 群聊正文不该落进保留 14 天的日志文件。界面最多保留 2600 行，翻查用「导出」。

> 注意：`\x1e` 在 Python 眼里也算空白，识别前缀时不能用 `lstrip()`，只剥空格和制表符（见 `_emit_message` 里的注释）。

---

## 4. 架构

### 4.1 进程与数据流

```
┌────────────────────────── FeishuBotManager.exe（PyInstaller 单文件）──────────────────────────┐
│                                                                                              │
│  WebView2 (Edge)                                        Python 主进程                          │
│  ┌───────────────────────────────┐   js_api 调用        ┌──────────────────────────────┐      │
│  │ index.html / app.js / style   │ ───────────────────▶ │ app/api.py  class Api        │      │
│  │  · bridge.call(name, ...args) │                      │   （约 50 个 public 方法）    │      │
│  │  · window.FBM（插件注册表）    │ ◀─────────────────── │ 返回值 / {ok,error}          │      │
│  └───────────────────────────────┘   Promise 结果        └───────┬──────────┬───────────┘      │
│                                                                  │          │                  │
│                          ┌───────────────────────────────────────┘          │                  │
│                          ▼                                                  ▼                  │
│              core/config.py   core/process.py   core/logs.py   core/plugins.py                │
│                          │            │              │               │                        │
│              manager.config.json     Popen        logs\*.log      plugins\*                    │
│                                       │                                                        │
│                                       ▼  子进程（无窗口）                                       │
│                          node index.js  cwd=机器人目录  stdout ─▶ logs.add(..., "bot")         │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 4.2 分层职责

| 层 | 文件 | 职责 | 不该做的事 |
|---|---|---|---|
| 入口 | `run.py` | 调 `app.main.main()` | 任何业务逻辑 |
| 应用装配 | `app/main.py` | 单实例、窗口、托盘、生命周期、启动顺序 | 业务读写 |
| 接口层 | `app/api.py` | 校验入参、编排 core、组装返回结构 | 直接 `subprocess` / 直接写文件 |
| 领域层 | `app/core/*.py` | 配置、进程、日志、插件、自启 | 依赖 `webview` |
| 界面 | `app/web/` | 渲染、事件、轮询、桥调用 | 直接读文件、直接起进程 |

**约定**：界面永远不知道文件路径和进程细节，只认 `app/api.py` 的方法名；`core/` 里任何模块都不 import `webview`，保证 `tests/smoke.py` 能无 GUI 跑通。

### 4.3 目录结构

```
FeishuBotManager/
├─ run.py                     开发与打包共用入口
├─ app/
│  ├─ main.py                 单实例 / 窗口 / 托盘 / 生命周期
│  ├─ api.py                  前端可调用的全部后端方法（IPC 接口层）
│  ├─ core/
│  │  ├─ config.py            配置默认值、点路径读写、原子保存
│  │  ├─ process.py           机器人子进程托管与启动前体检
│  │  ├─ logs.py              环形缓冲日志 + 按天落盘 + 清理
│  │  ├─ plugins.py           插件发现、前端资源汇总、后端方法调用
│  │  ├─ envfile.py           .env 解析与「保留注释」的写回
│  │  └─ autostart.py         注册表开机自启
│  └─ web/
│     ├─ index.html           单页壳：5 个原生页面 + 插件页挂载点
│     ├─ css/style.css        主题与组件样式
│     └─ js/
│        ├─ app.js            桥、渲染、事件、轮询、插件加载
│        └─ animations.js     4 种动画预设
├─ plugins/quickcheck/        示例插件：环境体检（前端 + 后端）
├─ installer/
│  ├─ core.py                 安装核心：拷贝、快捷方式、注册表（GUI 与静默共用）
│  ├─ main.py                 安装向导 + --silent 模式
│  └─ web/                    安装向导界面
├─ tests/
│  ├─ smoke.py                无窗口自检（配置/日志/插件/API/envfile）
│  └─ proc_test.py            启停机器人的集成冒烟
├─ build.py                   打包主程序 → 根目录 FeishuBotManager.exe
├─ build_installer.py         打包安装包 → 上级目录 飞书机器人管家-安装包.exe
└─ manager.config.json        运行期生成的配置（不入安装包）
```

### 4.4 线程模型

| 线程 | 来源 | 用途 |
|---|---|---|
| UI 主线程 | `webview.start()`（阻塞） | 窗口事件、js_api 调用 |
| 读日志线程 | `process.py` 的 `_pump` | 逐行读机器人 stdout/stderr |
| 插件调用线程 | pywebview 内部 | 执行 `plugin_call` 的 Python 方法 |
| 安装线程 | `installer/main.py` 的 `work()` | 长耗时拷贝，避免卡住向导 |

`Api` 的窗口操作方法必须回到 UI 线程：`win_drag` / `win_resize` / `win_toggle_max` 会先拿到 `window.native`（旧版回落 `gui.form`），再用 `form.BeginInvoke` 把 `ReleaseCapture` / `WM_NCLBUTTONDOWN` 投递到主线程执行，否则鼠标捕获不在那个线程上，拖动会死锁或无反应。投递失败时退化为直接调用。

### 4.5 启动与退出序列

**启动**

1. `app/main.py:main()` 取互斥体，已在运行则弹提示并退出；
2. 依次构造 `Config → LogStore → BotProcess → PluginHost → Api`；
3. `webview.create_window(...)`，注册 `closing` / `loaded` 事件；
4. 启动托盘线程；
5. `webview.start()` 阻塞；
6. `loaded` 事件里：若 `bot.autoStart` 且机器人目录已配置，自动 `start()`。

**退出**（托盘菜单「退出」/ `quit_app`）

1. 置 `api._closing = True`，销毁窗口；
2. `webview.start()` 返回；
3. 若 `bot.stopOnExit`（默认）→ `bot.stop()`（Windows 走 `taskkill /PID <pid> /T /F`，连子进程一起收）；
4. 写一条「管家已退出」日志后退出。

**关窗 ≠ 退出**：`closing` 事件在托盘可用时返回 `False` 并 `hide()`，进程继续常驻。

### 4.6 错误处理策略

| 场景 | 策略 |
|---|---|
| 界面调用后端 | 一律返回结构体，不抛异常穿透到 JS：写操作 `{ok: true/false, ...}`，读操作直接返回数据 |
| 插件后端异常 | 捕获后返回 `{ok:false, error, trace}`，并写一条 `plugin/error` 日志 |
| 机器人启动失败 | `start_bot` 返回 `{ok:false, message}`，`message` 来自体检结论 |
| 主流程未捕获异常 | 写 `crash.log`（内容为完整 traceback）并弹系统对话框，而非静默退出 |

---

## 5. 开发环境

```bash
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
.venv\Scripts\python run.py
```

依赖（`requirements.txt`）：

| 包 | 用途 |
|---|---|
| `pywebview>=6.0` | 窗口与 JS↔Python 桥 |
| `pystray>=0.19.5` | 系统托盘 |
| `Pillow>=10.0` | 托盘图标、打包时生成 ico |
| `pyinstaller>=6.0` | 打包（仅构建期） |

开发要点：

- **改界面**：`app/web/` 下的文件每次启动重新加载（`private_mode=True`，不吃 WebView2 缓存），关窗重开即生效，不必重启 Python。
- **调试界面**：设 `FBM_DEBUG=1` 再启动，`webview.start(debug=True)` 会开放 WebView2 DevTools。
- **无窗口看界面**：直接用浏览器打开 `app/web/index.html`。`bridge.call` 等不到 `pywebview.api` 时会在 400 ms 后落到内置 `MOCK` 假数据，可用于纯前端调样式。
- **改后端**：改 `app/core/` 必须重启进程。

---

## 6. 前后端 IPC 接口参考

### 6.1 调用约定

前端唯一入口是 `bridge.call(name, ...args)`：

```js
const r = await bridge.call("get_logs", 0);   // → window.pywebview.api.get_logs(0)
```

| 规则 | 说明 |
|---|---|
| 命名 | 方法名即 `app/api.py` 中的 **public 方法名**（snake_case）；以 `_` 开头的不暴露 |
| 就绪等待 | 轮询直到 `typeof pywebview.api[name] === "function"`；应用内最多等 **10 s**，浏览器预览等 400 ms |
| 浏览器降级 | 不在 pywebview 容器内时返回 `MOCK[name](...args)`，无假数据则为 `null` |
| 超时失败 | 容器内 10 s 仍未就绪则抛 `后端接口 <name> 未就绪`，由调用方 `try/catch` |
| 返回约定 | 写操作 → `{ok, ...}`；查询 → 数据本身（对象/数组/布尔）；窗口操作 → `None` |
| 参数 | 只传 JSON 可序列化的值；后端方法签名里的默认值会被沿用（`get_logs(0)` 等价于全量增量） |

### 6.2 接口清单

#### 启动与状态

| 方法 | 参数 | 返回 |
|---|---|---|
| `bootstrap()` | — | `{app:{name,version,frozen}, config, status, preflight, animations, envFields, plugins, autostart, platform:{os,py}}` |
| `get_status()` | — | `AppStatus`（见 6.3） |
| `get_preflight()` | — | `Preflight`（见 6.3） |

#### 进程控制

| 方法 | 参数 | 返回 | 说明 |
|---|---|---|---|
| `start_bot()` | — | `{ok:true, pid}` / `{ok:false, message}` | 已在运行 → `message="机器人已经在运行了"`；体检有 error → 各条结论以「；」连接；异常 → 异常文本 |
| `stop_bot()` | — | `{ok:true}` / `{ok:false, message}` | 未运行 → `message="机器人没在运行"` |
| `restart_bot()` | — | 同 `start_bot` | 内部为 `stop()` + 400 ms + `start()` |

#### 日志

| 方法 | 参数 | 返回 | 说明 |
|---|---|---|---|
| `get_logs(last_id=0)` | `last_id:int` | `LogItem[]` | 只返回 `id > last_id` 的记录，单次最多 800 条（前端增量拉取用） |
| `clear_logs()` | — | `bool` | 只清内存缓冲与界面，不删历史文件 |
| `export_logs()` | — | `{ok, path}` / `{ok:false, error}` | 落到 exe 同级 `logs-export-YYYYMMDD-HHMMSS.txt`，并在日志里记一行 |

#### 配置

| 方法 | 参数 | 返回 | 说明 |
|---|---|---|---|
| `save_settings(patch)` | `patch:object` | `{ok, config}` | 对整棵配置做深合并后落盘（用于 `bot.*`、`window.*`、`log.*`） |
| `set_ui(patch)` | `patch:object` | `{ok, ui}` | 只合并 `ui.*`（`animation` / `theme` / `accent`） |
| `set_close_action(action)` | `action:"tray"\|"quit"` | `{ok, action}` | 设置关闭窗口行为，立即写盘，下一轮关窗生效 |
| `set_autostart(enabled)` | `enabled:bool` | `{ok, enabled}` | 写 HKCU `Run` 键 |
| `pick_folder()` | — | `string \| null` | 系统文件夹选择框；取消返回 `null` |
| `use_bundled_bot()` | — | `{ok, dir}` 或 `{ok:false, error}` | 把机器人目录切到安装包自带的 `<exe 目录>\bot`，并落盘 |
| `open_path(path)` | `path:string` | `bool` | 资源管理器打开；路径不存在返回 `false` |
| `open_url(url)` | `url:string` | `bool` | 仅允许 `http` / `https` |
| `open_feishu_console()` | — | `{ok, url, exact}` | 在系统浏览器打开飞书开放平台；能读到 `FEISHU_APP_ID` 就直达该应用的「凭证与基础信息」页（`exact:true`），否则落到应用列表 |
| `feishu_console_url()` | — | `{ok, url, exact}` | 同上但只算地址、不打开（给需要预览链接的场景） |

#### 机器人 `.env`

| 方法 | 参数 | 返回 | 说明 |
|---|---|---|---|
| `get_env()` | — | `{ok:true, path, exists, raw, values}` / `{ok:false, path, error}` | `raw` 为原文，`values` 为解析结果 |
| `save_env(patch)` | `patch:{KEY:string}` | `{ok, values}` | 按字段写回，**保留注释、空行与原有顺序**，新键追加到末尾 |
| `save_env_raw(text)` | `text:string` | `{ok}` | 覆盖写整份文件（原始编辑器用） |
| `reveal_env()` | — | `bool` | 在资源管理器中选中 `.env` |

#### 文档清单 `docs.json`

| 方法 | 参数 | 返回 | 说明 |
|---|---|---|---|
| `list_docs()` | — | `{ok, path, docs:DocEntry[]}` | `DocEntry` 额外带 `index` 与 `token` |
| `add_doc(url, name="", writable=True)` | | 同 `list_docs` + `{added, hint, supported}` | 失败 → `{ok:false, error}`；`hint` 提示链接被识别成什么类型 |
| `remove_doc(index)` | `index:int` | 同 `list_docs` | 越界 → `error="这一项不存在，刷新一下列表"` |
| `rename_doc(index, name)` | | 同 `list_docs` | 名称去空白，不能为空 |
| `set_doc_writable(index, writable)` | | 同 `list_docs` | 决定机器人能否写回 |
| `get_docs()` | — | `{ok, path, raw}` | 原始 JSON 文本 |
| `save_docs(text)` | `text:string` | `{ok}` | 校验 JSON 合法性；失败 `error="JSON 格式不对：…"` |

#### 配置导入导出

| 方法 | 参数 | 返回 | 说明 |
|---|---|---|---|
| `export_config()` | — | `{ok, path, count}` / `{ok:false, canceled:true}` / `{ok:false, error}` | 导出 `env` + `docs` 两类数据 |
| `import_config()` | — | `{ok, count, keys, docs, path}` / `canceled` / `{ok:false, error}` | `keys` 为导入的 env 键名列表；`docs` 表示是否一并恢复 docs.json |

#### 插件

| 方法 | 参数 | 返回 | 说明 |
|---|---|---|---|
| `plugin_list()` | — | `PluginInfo[]` | 见 6.3 |
| `plugin_ui()` | — | `{id, name, js, css}[]` | 启动时前端一次性取走所有可执行资源（`js` 为源码字符串） |
| `plugin_call(pid, method, payload=None)` | | `{ok, data}` / `{ok:false, error, trace}` | 调插件后端方法；`payload` 为 `None` 时以无参形式调用 |
| `plugin_toggle(pid, enabled)` | | `{ok, plugins}` | 写 `plugins.disabled` 并落盘；停用同时清后端缓存 |
| `open_plugins_dir()` | — | `bool` | |
| `reload_plugins()` | — | `{ok, plugins, ui}` | 重新扫描目录、清后端缓存，前端据此重建侧栏 |
| `import_plugin_drop(items)` | `items`：`{kind:"folder",name,files:[{rel,b64}]}` 或 `{kind:"zip",name,b64}` | `{ok, imported, errors, plugins, ui}` | 拖入安装（见 7.7）；同名不覆盖，逐项报错 |

#### 窗口

| 方法 | 参数 | 返回 | 说明 |
|---|---|---|---|
| `win_minimize()` | — | `None` | 最小化 |
| `win_toggle_max()` | — | `None` | 最大化/还原；以 `Form.WindowState` 为准（Aero snap、`Win+↑` 也能正确还原），最大化前用 `Screen.WorkingArea` 校正边界 |
| `win_drag()` | — | `None` | 交给系统原生移动（见 3.3） |
| `win_resize(edge)` | `left` \| `right` \| `top` \| `bottom` \| `topleft` \| `topright` \| `bottomleft` \| `bottomright` | `None` | 交给系统原生缩放；未知名忽略，最大化时先还原（见 3.3） |
| `win_hide()` | — | `None` | 收托盘（界面右上角 ×） |
| `win_close()` / `quit_app()` | — | `None` | 真正退出（销毁窗口，进程随 `webview.start` 返回而结束） |

> 窗口方法依赖 `window.native`（pywebview 6 的命名），内部对旧版 `window.gui.form` 做了兼容。

#### 杂项

| 方法 | 参数 | 返回 |
|---|---|---|
| `copy_text(text)` | `text:string` | `bool`（Windows 剪贴板，调用 `clip`） |

### 6.3 数据结构

**AppStatus** —— `get_status()`、`bootstrap().status`

```json
{ "running": true, "pid": 12088, "uptime": 3725,
  "lastExit": 0, "botDir": "D:\\...\\feishu-deepseek-bot", "node": "node" }
```

**Preflight** —— `get_preflight()`、`bootstrap().preflight`

```json
{ "ok": false, "node": "node",
  "issues": [ { "level": "error", "text": "机器人目录不存在：D:\\...\\bot" },
              { "level": "warn",  "text": "没有 .env，机器人启动后会因为缺凭证报错" } ] }
```

`level` 只有 `error`（阻止启动）与 `warn`（可启动但会出问题）。判定项：

| 检查 | 级别 |
|---|---|
| 机器人目录存在 | `error` |
| 目录下有 `index.js` | `error` |
| 能解析到 `node` 可执行文件 | `error` |
| 存在 `.env` | `warn` |
| 存在 `node_modules` | `warn` |

**LogItem** —— `get_logs()`

```json
{ "id": 42, "ts": 1761547200.5, "time": "2026-10-27 15:20:00",
  "level": "info", "source": "bot", "text": "Bot 已连接飞书" }
```

- `source` ∈ `manager` / `bot` / `plugin`
- `level` ∈ `info` / `warn` / `error`；显式传入优先，否则按关键词推断（`[error]`/`错误`/`失败` → error，`[warn]`/`警告`/`⚠` → warn）

**DocEntry** —— `list_docs().docs[]`

```json
{ "index": 0, "name": "产品手册", "url": "https://x.feishu.cn/docx/Abc123",
  "token": "Abc123", "docType": "文档", "writable": true, "note": "" }
```

`docs.json` 里存的是 `{name, type, url, writable}`，`index` / `token` / `docType` 由管家解析补全。

**文档类型支持矩阵**（`app/api.py` 的 `DOC_TYPES`）

| 链接段 | 类型 | 可读写 |
|---|---|---|
| `/docx/` | 文档 | ✅ |
| `/wiki/` | 知识库 | ✅ |
| `/sheets/` | 电子表格 | ✅ |
| `/base/` | 多维表格 | ❌ 只登记 |
| `/mindnotes/` | 思维笔记 | ❌ 只登记 |
| `/slides/` | 幻灯片 | ❌ 只登记 |
| `/docs/` | 旧版文档 | ❌ 只登记 |

链接解析规则：正则 `/(docx|wiki|sheets|base|mindnotes|slides|docs)/([A-Za-z0-9]+)`；只有 15 位以上裸 token（URL 末尾直接给 token）才按 `docx` 处理；`/wiki/` 链接会额外提示形如 `?sheet=` / `?table=` 的子资源。

**PluginInfo** —— `plugin_list()`

```json
{ "id": "quickcheck", "name": "环境体检", "version": "1.0.0",
  "description": "…", "author": "example", "hasUi": true, "hasBackend": true,
  "tab": {"title": "环境体检"}, "enabled": true, "error": "", "path": "…\\plugins\\quickcheck" }
```

`error` 非空表示清单解析失败（此时插件不会出现在侧栏）。

### 6.4 `.env` 写回规则

`save_env(patch)` 不走「重写整个文件」，而是逐行扫描替换：

- 匹配 `^\s*KEY\s*=\s*(.*)$` 的已有行就地替换值，**注释、空行、顺序全部保留**；
- 变量值含空白、`#`、引号时自动加双引号并转义；
- `patch` 里的新键追加到文件末尾；
- 空值写成 `KEY=`。

加新配置字段的完整链路：`app/api.py` 的 `ENV_FIELDS` 加一项 → 前端表单自动出现 → `save_env` 自动生效，**其他地方不用改**。

---

## 7. 插件开发

### 7.1 目录约定

插件就是 `plugins\` 下的一个文件夹，**改完点「插件」页的「重新加载」立即生效，不用重新打包 exe**。

```
plugins/
└─ my-plugin/
   ├─ plugin.json     清单（必需）
   ├─ plugin.js       前端（可选：要加侧栏页面或注入样式时才需要）
   ├─ plugin.css      样式（可选，由清单 css 字段引用）
   └─ backend.py      后端（可选：要跑 Python 时才需要）
```

### 7.2 清单 `plugin.json`

| 字段 | 必需 | 说明 |
|---|---|---|
| `id` | ✅ | 唯一标识，建议与文件夹同名；也是 `plugin_call` 的第一个参数 |
| `name` | | 显示名 |
| `version` | | 语义化版本，仅展示 |
| `description` | | 一句话说明，显示在插件页 |
| `author` | | 作者 |
| `tab` | | `{ "title": "…" }`；**存在才**在侧栏加入口，不写就是纯后台插件 |
| `ui` | | 前端脚本文件名，相对插件目录 |
| `css` | | 注入到 `<style id="plugin-css-<id>">` 的样式文件名 |
| `backend` | | 后端 Python 文件名，`register(ctx)` 必须返回 `{方法名: 函数}` |

```json
{
  "id": "quickcheck",
  "name": "环境体检",
  "version": "1.0.0",
  "description": "演示插件：前端加一个标签页，后端跑一段 Python。",
  "author": "example",
  "tab": { "title": "环境体检" },
  "ui": "plugin.js",
  "backend": "backend.py"
}
```

### 7.3 前端 `plugin.js`

```js
FBM.registerPlugin({
  id: "my-plugin",
  name: "我的插件",
  tab: { title: "我的插件" },

  mount(root, ctx) {
    root.innerHTML = `<div class="card"><button class="btn primary" id="go">跑一下</button>
      <pre class="code" id="out"></pre></div>`;

    root.querySelector("#go").onclick = async () => {
      const res = await ctx.pluginCall("hello", { name: "飞书" });
      root.querySelector("#out").textContent = JSON.stringify(res, null, 2);
      ctx.toast("跑完了");
    };
  },
});
```

**加载时机**：应用启动时 `plugin_ui()` 取回所有插件脚本，用 `new Function("FBM", js)(FBM)` 执行（绕开 `file://` 下 `<script src>` 的同源限制），因此脚本里**不要写顶层 `import`/`export`**，也拿不到模块作用域。`mount` 在首次切到该插件页时才调用，且只调用一次。

**`mount(root, ctx)` 的 `ctx`**

| 成员 | 说明 |
|---|---|
| `ctx.api(name, ...args)` | 直接调管家后端接口，如 `ctx.api("start_bot")`、`ctx.api("get_status")` |
| `ctx.pluginCall(method, payload)` | 调**自己插件**的后端方法，返回 `{ok, data}` / `{ok:false, error}` |
| `ctx.toast(text, kind?)` | 右下角提示，`kind` ∈ `ok` / `warn` / `err` |
| `ctx.state` | 前端共享状态（只读参考：`status` / `config` / `logs` / `plugins` …） |
| `ctx.el(tag, className?, text?)` | 创建 DOM 元素的小工具 |

`window.FBM` 全局对象本身还提供 `FBM.api` / `FBM.pluginCall` / `FBM.toast` / `FBM.el`，语义相同。

**可复用样式**：`card` / `card-head` / `btn` / `btn primary` / `field` / `row-title` / `row-desc` / `code` / `tag` / `empty` / `muted`，跟随主题变量自动变色；新增样式建议用自己插件 id 作为前缀，避免污染主界面。

### 7.4 后端 `backend.py`

```python
def register(ctx):
    def hello(payload=None):
        ctx["log"]("有人点了按钮")                       # 写日志（带 plugin 前缀）
        bot_dir = ctx["config"].get("bot.dir")           # 读管家配置
        ctx["config"].set("plugins.lastRun", "hello")    # 写并立即落盘
        return {"echo": (payload or {}).get("name"), "bot": bot_dir}

    return {"hello": hello}
```

| `ctx` 成员 | 说明 |
|---|---|
| `ctx["pluginId"]` | 自己的插件 id |
| `ctx["log"](text, level="info")` | 写进运行日志，`source="plugin"` |
| `ctx["config"].get(path, default=None)` | 点路径读取管家配置，如 `"bot.dir"` |
| `ctx["config"].set(path, value)` | 写配置并**立即保存**，返回 `bool` |
| `ctx["config"].all()` | 读取整棵配置（副本，改它不落盘） |

**调用语义**

- `register(ctx)` 必须返回 `{方法名: 函数}`，非 `dict` 视为加载失败；
- `plugin_call(pid, method, payload)`：`payload` 为 `None` 时以无参方式调用，否则作为唯一参数传入 —— 所以方法签名写成 `def f(payload=None)`；
- 返回值必须是 JSON 可序列化对象，包在 `{ok:true, data:...}` 里回给前端；
- 抛异常时返回 `{ok:false, error, trace}`（`trace` 为最后 3 帧），同时写一条 `plugin/error` 日志；
- 后端模块**懒加载并缓存**：首次 `plugin_call` 时才 import；「重新加载插件」会清空缓存，因此模块级的全局变量在重载后失效。

### 7.5 调用时序

```
plugin.js: ctx.pluginCall("hello", {...})
   → bridge.call("plugin_call", "my-plugin", "hello", {...})
   → Api.plugin_call → PluginHost.call → 动态 import backend.py → register(ctx) → hello(payload)
   → {ok: true, data: {...}} → Promise 结果
```

### 7.6 安全边界

插件是**进程内执行的可信代码**，没有沙箱、没有权限声明、没有签名校验：它能读写任意文件、起进程、发网络请求，与控制台权限相同。对外分发 exe 时请明确这一点，只安装可信来源的插件。

### 7.7 拖入安装

把**插件文件夹**或 **.zip 压缩包**直接拖进窗口，拖拽过程中会盖上一层全屏提示（平时不显示任何提示文字），松手即安装：

- 只认两种形态：含 `plugin.json` 的文件夹、含 `plugin.json` 的 `.zip`（压缩包里套一层同名目录也能识别，最多往下剥 3 层）。
- 落盘位置是 `plugins\<id>`：`id` 取清单里的 `id`，没写就用文件夹名 / 压缩包内顶层目录名。
- **同名不覆盖**：目标目录已存在会报「插件 x 已经存在，先删掉旧的再拖进来」，删掉旧目录再拖即可。
- 安装完自动 `reload()` 并刷新插件列表与侧栏，不用再点「重新加载」。
- 校验：相对路径不许 `..`、不许绝对路径；解压不用 `extractall`，逐个写文件并累加大小，上限 40 MB / 3000 个文件；界面侧传输上限 30 MB。
- 链路：`bindDropImport()` → `webkitGetAsEntry()` 递归读目录 → base64 → `import_plugin_drop(items)` → `PluginHost.import_dropped()`。

> WebView2 出于安全不给页面真实磁盘路径，所以实现是「把内容传上来再落盘」而不是「把路径交给后端复制」；超大目录会在读取阶段被拦下。

### 7.8 内置插件：联网搜索

`plugins/websearch/` 给机器人开联网搜索。搜索与网页抓取由 **DeepSeek 官方接口**完成，复用机器人 `.env` 里已有的 `DEEPSEEK_API_KEY`，不需要再注册搜索服务。

| 组成 | 位置 | 作用 |
| --- | --- | --- |
| 插件页 | `plugins/websearch/plugin.js` | 开关、结果条数、保存、保存并重启机器人、测试台 |
| 插件后端 | `plugins/websearch/backend.py` | 读写 `.env` 的 `WEB_SEARCH` / `WEB_SEARCH_MAX_RESULTS`，并代调一次搜索做自检 |
| 机器人工具 | `<机器人目录>/search.js` | 暴露 `web_search` / `fetch_url` 两个工具，由 `index.js` 注册进工具列表 |

- 机器人侧开关：`.env` 里 `WEB_SEARCH=on`（或 `1`/`true`/`yes`）且 `DEEPSEEK_API_KEY` 非空才生效；`WEB_SEARCH_MAX_RESULTS` 控制每次条数（默认 5，界面里 1/3/5 三档）。
- 模型只为「需要实时信息」的问题调用这两个工具，结论里带 `[标题](链接)`；抓回的网页正文会被截断到 6000 字再喂给模型。
- 接口：`POST https://api.deepseek.com/v1/tools/search`（`query`、`count`、`need_content`）与 `POST /v1/tools/fetch`（`url`），`Authorization: Bearer <DEEPSEEK_API_KEY>`。
- 缓存：同一 query 10 分钟内复用结果，最多存 200 条；失败会返回中文原因（超时 / HTTP 状态码）。
- 改完 `.env` 必须**重启机器人**才生效（插件页有「保存并重启机器人」按钮）。
- 机器人代码（`index.js` / `search.js`）在安装包里是一份快照：改完要回源项目改，再重打安装包；安装器遇到已存在的 `bot\` 会跳过，避免覆盖你改过的代码与 `.env`。

---

## 8. 运行时文件与配置格式

### 8.1 文件清单

| 文件 | 位置 | 生命周期 |
|---|---|---|
| `FeishuBotManager.exe` | 安装目录 / 项目根目录 | 程序本体 |
| `manager.config.json` | exe 同级 | 首次启动自动生成，缺失时用默认值 |
| `logs\manager-YYYY-MM-DD.log` | exe 同级 | 按天追加，超 `log.keepDays`（默认 14 天）自动清理 |
| `logs-export-<时间戳>.txt` | exe 同级 | `export_logs()` 生成 |
| `plugins\` | exe 同级 | 插件目录（开发态即源码目录） |
| `bot\` | 安装目录（安装版） | 安装包内置的机器人副本；只有 `bot.dir` 指向它时才会被拉起 |
| `卸载.bat` | 安装目录（安装版） | 卸载入口，等价于 `FeishuBotManager.exe --uninstall` |
| `.webview\` | exe 同级 | WebView2 缓存，可随时删除 |
| `crash.log` | exe 同级 | 主流程未捕获异常时生成 |
| `.env` | **机器人目录** | 机器人凭证与模型配置，管家代为编辑 |
| `docs.json` | **机器人目录** | 机器人可读文档清单，管家代为编辑 |

> 判断「exe 同级」的规则在 `core/config.py:app_dir()`：PyInstaller 打包态取 `sys.executable` 所在目录，开发态取项目根。因此**打包后配置与插件不会跟进包内**，这是刻意设计。

### 8.2 `manager.config.json`

```json
{
  "bot":   { "dir": "D:\\...\\feishu-deepseek-bot", "node": "node",
             "autoStart": false, "stopOnExit": true },
  "ui":    { "animation": "smooth", "theme": "dark", "accent": "#0a8f47" },
  "window":{ "frameless": true, "width": 1120, "height": 760 },
  "log":   { "maxLines": 3000, "keepDays": 14 },
  "plugins": { "disabled": [] }
}
```

| 键 | 默认 | 说明 |
|---|---|---|
| `bot.dir` | `""` | 机器人目录（含 `index.js`），空表示未配置 |
| `bot.node` | `"node"` | node 可执行文件名或绝对路径 |
| `bot.autoStart` | `false` | 管家启动时自动拉起机器人 |
| `bot.stopOnExit` | `true` | 管家退出时停掉机器人 |
| `ui.animation` | `"smooth"` | 见 3.2 |
| `ui.theme` | `"dark"` | 主题 |
| `ui.accent` | `"#0a8f47"` | 主色 |
| `window.frameless` | `true` | 无边框还是系统标题栏（改动需重启） |
| `window.closeAction` | `"tray"` | 点右上角 × 时：`tray` 收进托盘继续跑，`quit` 直接退出（`quit` 会顺带停机器人，遵循 `bot.stopOnExit`） |
| `window.width/height` | `1120/760` | 实际打开时按屏幕可用尺寸收缩，并夹到 `min_size=(980,640)` |
| `log.maxLines` | `3000` | 内存环形缓冲上限 |
| `log.keepDays` | `14` | 历史日志保留天数 |
| `plugins.disabled` | `[]` | 被停用的插件 id 列表 |

保存策略：先写 `manager.config.json.tmp`，再 `os.replace` 原子替换，避免写一半掉电损坏文件。

### 8.3 导出/导入格式

`export_config()` 产出的 JSON（不含 `manager.config.json` 本体，避免把机器相关信息带到别的电脑）：

```json
{
  "app": "FeishuBotManager",
  "version": 1,
  "exportedAt": "2026-10-27 15:20:00",
  "env":  { "FEISHU_APP_ID": "cli_xxx", "DEEPSEEK_MODEL": "deepseek-flash" },
  "docs": { "docs": [], "folders": [] }
}
```

`import_config()` 的兼容规则：`env` 必需（缺失直接报错）；`docs` 缺失或为 `null` 时只导入 env；`docs` 存在时整体覆盖机器人目录的 `docs.json`。

> ⚠️ 导出的 `env` 是**明文**，包含 App Secret 与 API Key。请勿把导出文件提交到仓库或发到群里。

### 8.4 `.env` 支持的字段

界面表单由 `app/api.py` 的 `ENV_FIELDS` 驱动，分三组：

| key | 分组 | 控件 | 说明 |
|---|---|---|---|
| `FEISHU_APP_ID` | 飞书 | 单行 | `cli_` 开头 |
| `FEISHU_APP_SECRET` | 飞书 | 密码 | 脱敏显示 |
| `DEEPSEEK_MODEL` | 模型 | 单行 | 如 `deepseek-flash` |
| `DEEPSEEK_BASE_URL` | 模型 | 单行 | 默认 `https://api.deepseek.com` |
| `DEEPSEEK_API_KEY` | 模型 | 密码 | 脱敏显示 |
| `BOT_NAME` | 人设 | 单行 | 机器人自称 |
| `SYSTEM_PROMPT` | 人设 | 多行 | 人设提示词 |
| `MAX_HISTORY_TURNS` | 人设 | 单行 | 上下文轮数 |

文件里出现但不在表单里的键，用「原始文本编辑器」编辑，保存时原样保留。

### 8.5 `docs.json`

```json
{
  "docs": [
    { "name": "产品手册", "type": "docx", "url": "https://x.feishu.cn/docx/Abc123", "writable": true }
  ],
  "folders": []
}
```

管家只读写 `docs` 数组；`folders` 字段原样保留、不做解析（供机器人本体使用）。`type` 由链接解析得出，`writable` 决定机器人是否允许写回该文档。

---

## 9. 构建与发布

### 9.1 打包主程序

```bash
.venv\Scripts\python build.py            # 默认单文件、无控制台
.venv\Scripts\python build.py --console  # 带控制台，看崩溃信息用
.venv\Scripts\python build.py --onedir   # 目录版，启动更快、体积更大
```

脚本内部调用 PyInstaller，关键参数：

| 参数 | 作用 |
|---|---|
| `--onefile` / `--onedir` | 单文件或目录产物 |
| `--windowed` / `--console` | 是否带控制台 |
| `--name FeishuBotManager` | 产物名 |
| `--add-data "app/web;web"` | 界面资源打进包内，运行时由 `res_dir()` 定位 |
| `--collect-all webview` | 收全 pywebview 的平台组件 |
| `--hidden-import pystray._win32 / PIL._imaging / clr_loader` | 动态导入，静态分析会漏 |
| `--exclude-module tkinter / numpy / pytest` | 瘦身 |
| `--icon build/icon.ico` | 图标由 `make_icon()` 用 Pillow 现画并输出多尺寸 ico |

产物从 `dist\` 移到项目根目录的 `FeishuBotManager.exe`，随后删除空的 `dist\`。**打包前必须关掉正在运行的管家**，否则替换文件会 `PermissionError`（脚本会明确提示）。

### 9.2 打包安装包

```bash
.venv\Scripts\python build.py              # 先出主程序
.venv\Scripts\python build_installer.py    # 再出安装包
```

`build_installer.py` 分两步：

1. **准备负载** `build\payload\` —— 四样：`FeishuBotManager.exe`、`README.md`、`plugins\`（剔除 `__pycache__` / `*.pyc` / `*.log`），以及 `bot\`（从同级 `feishu-deepseek-bot` 复制，剔除 `.env` / `docs.json` / `*.log` / `.git`；找不到源目录时跳过并在输出里提示）。**不再打独立卸载器**：卸载逻辑已收进主程序的 `--uninstall`，省掉 8.4 MB 的第二个 Python 运行时。
2. **打安装包** —— `installer/main.py` + `payload` + `installer/web` → `飞书机器人管家-安装包.exe`，并复制到**上级目录**（即 `飞书机器人\` 交付目录）。

体积参考（本机实测）：主程序 **15.0 MB**、安装包 **31.3 MB**。主程序能压到 15 MB，是因为 `build.py` 排除了两个用不到的 Pillow 模块（`PIL._avif` 4.1 MB、`PIL._imagingft` 1.0 MB）；**`ssl` 不能排** —— pywebview 在 `webview/__init__.py` 顶层 `import ssl`，排掉会启动即 `ModuleNotFoundError`。

**明确不进包**：`manager.config.json`、`logs\`、`.webview\`、机器人的 `.env` / `docs.json`。`stage_payload()` 是这条规则的唯一开关，改打包内容只改它。

### 9.3 安装程序

向导式图形安装（800×640，最小 720×540），核心逻辑在 `installer/core.py`，GUI 与静默模式共用同一份实现。

| 项目 | 取值 |
|---|---|
| 默认安装目录 | `%LOCALAPPDATA%\Programs\FeishuBotManager` |
| 选目录规则 | 用户在向导里选的只是**父目录**（如 `D:\software`），安装器自动补成 `D:\software\FeishuBotManager`；若所选目录本身已叫 `FeishuBotManager` / `飞书机器人管家`，则原样使用（不会套两层） |
| 已安装检测 | 启动时读 HKCU 卸载项（退回 `%LOCALAPPDATA%\Programs\FeishuBotManager`），找到就把向导里的路径预填成原位置，并提示「检测到已安装 vX：<路径>，将覆盖安装」；静默模式省略 `--dir` 时同样装回原位置，不会在别的盘再放一份 |
| 覆盖策略 | 覆盖 `FeishuBotManager.exe` / `README.md` / `卸载.bat`；`plugins\` 与 `bot\` **已存在则跳过**，保留用户插件、改过的机器人代码与 `.env` |
| 运行中拦截 | 安装器启动与点「安装」前都会 `tasklist` 检查；管家在跑时按钮变「管家运行中」并提示先从托盘退出（在跑的 exe 写不进去） |
| 安装步骤（进度） | 4% 准备目录 → 18% 复制主程序 → 52% 复制插件 → 62% 复制文档 → 66% 复制机器人 → 70% 写卸载入口 → 72% 清理旧卸载器 → 78% 注册表 → 84% 快捷方式 → 100% |
| 插件覆盖策略 | 目标 `plugins\` **已存在则跳过**，避免冲掉用户自装插件 |
| 机器人副本 | `bot\`（内置一份机器人：`index.js` / `docs.js` / `node_modules` 等，**不含** `.env` 与 `docs.json`）；目标 `bot\` 已存在则跳过，不动用户改过的代码与 `.env` |
| 安装包体积 | 约 31 MB（内置机器人压缩后约 4 MB） |
| 桌面快捷方式 | `飞书机器人管家.lnk`（PowerShell + WScript.Shell 创建）。桌面位置读注册表 `Explorer\Shell Folders\Desktop`，所以桌面被重定向到 `D:\Desktop` 或 OneDrive 也能落到你看得见的地方；卸载时按同一路径清理 |
| 开始菜单 | `飞书机器人管家.lnk` 与 `卸载 飞书机器人管家.lnk`（后者带 `--uninstall` 参数） |
| 安装目录内 | `卸载.bat`（95 字节，`start "" "%~dp0FeishuBotManager.exe" --uninstall`）——给习惯「在文件夹里找卸载」的人留的入口，整个目录拷走也不失效 |

**注册表卸载项**：`HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\FeishuBotManager`

| 值 | 内容 |
|---|---|
| `DisplayName` | 飞书机器人管家 |
| `DisplayVersion` | 1.0.1 |
| `Publisher` | 九叶化妆品 |
| `InstallLocation` | 安装目录 |
| `DisplayIcon` | `<安装目录>\FeishuBotManager.exe,0` |
| `UninstallString` | `"<安装目录>\FeishuBotManager.exe" --uninstall` |
| `QuietUninstallString` | `"<安装目录>\FeishuBotManager.exe" --uninstall --yes` |
| `NoModify` / `NoRepair` | `1` / `1` |

全部写 HKCU，**不需要管理员权限**。

**静默安装**

```bash
飞书机器人管家-安装包.exe --silent
飞书机器人管家-安装包.exe --silent --dir "D:\Apps\FeishuBotManager"
飞书机器人管家-安装包.exe --silent --dir "D:\Apps\FBM" --no-shortcuts --no-registry
```

| 参数 | 说明 |
|---|---|
| `--silent` | 无界面安装 |
| `--dir <path>` / `--dir=<path>` | 目标路径，缺省用默认目录。给父目录（如 `D:\Apps`）会自动补成 `D:\Apps\FeishuBotManager`；名字已经是 `FeishuBotManager`/`飞书机器人管家` 时原样使用 |
| `--no-shortcuts` | 不建桌面与开始菜单快捷方式 |
| `--no-registry` | 不写卸载注册项 |

安装失败时，图形模式弹 MessageBox 并把 traceback 写到 `%TEMP%\fbm-setup-error.log`；静默模式直接以退出码 1 结束。

### 9.4 卸载

**不再有独立的 `卸载.exe`**，卸载由主程序自己完成（实现见 `app/main.py` 的 `_run_uninstall`）。三个入口等价：

1. 安装目录里的 `卸载.bat`（双击）；
2. 开始菜单「卸载 飞书机器人管家」；
3. 「设置 → 应用」里点卸载，或命令行 `FeishuBotManager.exe --uninstall`。

流程：

```bash
FeishuBotManager.exe --uninstall        # 弹确认框
FeishuBotManager.exe --uninstall --yes  # 静默，注册表 QuietUninstallString 用这个
```

进入卸载分支后**不创建任何窗口、不创建单实例互斥体**，流程是：

1. 确认（`--yes` 跳过），先清理 HKCU 卸载项、桌面与开始菜单快捷方式；
2. 写一个 `%TEMP%\fbm-uninstall.cmd`（GBK 编码）并 detached 启动，内容依次是：等 1 秒 → `taskkill FeishuBotManager.exe` → 最多重试 20 次删安装目录 → 删掉脚本自身；
3. 主程序随即 `sys.exit(0)`，剩下的删除交给那个脚本 —— 避免「进程删自己」的死锁；
4. 删除范围：安装目录（含 `plugins\`、`logs\`、`.webview\`、`manager.config.json`）；
5. **不动**机器人目录里的 `.env` / `docs.json`，也不删机器人本体。

> 清理按两套名字兜底：安装器用中文名「飞书机器人管家」建快捷方式，而主程序内部 `APP_NAME` 是 `"FeishuBotManager"`，因此 `_remove_shortcuts()` 会同时扫描中英文名（含 `卸载 ` 前缀），避免改名后留下孤儿快捷方式。

---

## 10. 测试与自检

仓库没有引入测试框架（无 pytest / CI），用两个可直接运行的脚本：

| 脚本 | 作用 | 是否需要 GUI |
|---|---|---|
| `tests\smoke.py` | 无窗口自检：配置读写、`.env` 合并保留注释、日志级别推断、体检结论、插件调用、`bootstrap` 结构 | 否 |
| `tests\proc_test.py` | 集成冒烟：真的启动机器人、等 4 秒、打印状态与最后几条日志、再停掉 | 否（只实例化 app，不开窗口） |

```bash
.venv\Scripts\python tests\smoke.py
.venv\Scripts\python tests\proc_test.py
```

改完代码后的人工检查清单：

1. 概览页启动/停止/重启，状态灯与运行时长同步；
2. 机器人配置页改一个字段保存，`.env` 注释与顺序未被破坏；
3. 加一个文档链接，`docs.json` 结构正确，`/wiki/` 带 `?sheet=` 的链接被识别；
4. 日志页过滤、搜索、导出、清空；
5. 插件页启停 `quickcheck`，切页看数据是否正常；
6. 设置页切动画、切边框、改路径，重启后仍生效。

---

## 11. 故障排查

| 症状 | 可能原因 | 处理 |
|---|---|---|
| 双击后没反应 | 已有实例在跑（单实例互斥） | 看右下角托盘 |
| 「启动」被拦下，体检报目录不存在 | `bot.dir` 未配置或被移动 | 设置 → 运行环境 重新选目录 |
| 体检报「找不到 Node」 | `bot.node` 不在 PATH | 填 node 绝对路径，或装 Node 后重启管家 |
| 机器人起来后很快退出 | 机器人目录缺 `.env` 或凭证失效 | 体检里是 `warn`，按提示补凭证；日志页看退出码与 stderr |
| 关窗后进程还在 | `window.closeAction` 默认为 `tray`（收托盘） | 设置 → 关闭窗口时 改成「退出应用」，或用托盘菜单退出 |
| 界面白屏 | WebView2 运行时缺失，或 `web\index.html` 没打进去 | 安装 Edge WebView2 Runtime；检查 `--add-data` |
| 插件不出现 | `plugin.json` 解析失败（`plugin_list()` 的 `error` 有值）/ 未启用 / 没写 `tab` | 修 JSON、插件页启用 |
| 插件改完没生效 | 后端模块有缓存 | 插件页点「重新加载」 |
| 打包报 `PermissionError` | 旧 exe 正在运行 | 关掉管家再打包 |
| 拖不动窗口 | 少数缩放/多屏环境 | 设置 → 窗口边框 切系统标题栏 |
| 安装失败并提示无写入权限 | 目标目录被占用或受保护 | 从托盘退出管家；换目录或换用户 |

日志是排查第一入口：`logs\manager-YYYY-MM-DD.log`（`[bot]` 前缀为机器人输出），启动期异常另见 `crash.log`。

---

## 12. 已知限制与维护约定

**限制**

- 仅 Windows：依赖 Win32 原生窗口移动、注册表自启、`taskkill`、`clip`；
- 单文件 exe 约 15 MB（安装包约 31 MB，含内置机器人），每次启动需解压到临时目录，首次启动 1–2 s；
- 内置的 `bot\` 是打包那一刻的快照：机器人代码更新后需要重打安装包，或把机器人目录指回你的开发目录（设置 → 运行环境 → 选择）；
- 卸载必须走 `FeishuBotManager.exe --uninstall`；手工只删安装目录会留下注册表卸载项与快捷方式；
- 无边框窗口在部分屏幕缩放/多屏组合下表现不完美，已用 `Screen.WorkingArea` 兜底，仍可切回系统标题栏；
- 缩放热区压在窗口最外侧 4–5px（角 12px）上，恰好落在那几像素里的控件点击会被缩放接管；
- 缩小到 `min_size`（980×640）后不能再小，拖边不会有额外反馈；
- 拖入安装走 base64 上传，界面侧上限 30 MB、落盘上限 40 MB；更大的插件请手动放进 `plugins\`；
- 插件无沙箱、无签名校验，属于可信代码；
- `bridge.call` 单次最长等 10 s，长任务应改为「立即返回 + 轮询进度」（参考安装器的 `progress()` 模式）；
- 文档清单只对 `docx` / `wiki` / `sheets` 支持读写，`base` / `mindnotes` / `slides` / 旧版 `docs` 仅登记；
- 导出配置含明文密钥，见 8.3 的安全提示。

**维护约定**

- 新增前端能力：先在 `app/api.py` 加方法（返回 `{ok, ...}` 结构），再在 `app/web/js/app.js` 里 `bridge.call` 调用，最后补本节接口表；
- 新增配置项：只改 `app/core/config.py` 的 `DEFAULTS`，`Config.get` 对缺失键自动回落到默认值；
- 新增 `.env` 字段：只改 `app/api.py` 的 `ENV_FIELDS`，表单与写回自动跟上；
- 新增动画预设：同时改 `app/api.py` 的 `ANIMATIONS`（下发清单）与 `app/web/js/animations.js`（实现）；
- 版本号目前硬编码在两处（`app/core/config.py:11`、`installer/core.py:18`），发版前手工对齐；
- 打包内容开关只在 `build_installer.py:stage_payload()`；打包**排除项**只在 `build.py` 的 `--exclude-module`，改完必须跑一次启动回归（尤其 PIL 模块，排错会白屏/托盘没图标）；
- 卸载与首次运行目录创建都在 `app/main.py`（`_run_uninstall` / `_ensure_dirs`），`build_installer.py` 只负责把 `payload` 塞进安装器；
- 安装目录规则只有一处真相：`installer/core.py:resolve_target()`；向导里的 `resolveDir()` 只做输入框预览，改规则时两边一起对齐；
- 任何 `core/` 模块都不得 import `webview`，否则 `tests/smoke.py` 会挂。
