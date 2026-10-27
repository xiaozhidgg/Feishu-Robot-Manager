"""前端与 Python 之间的桥。所有 public 方法都会被 JS 通过 window.pywebview.api.* 调到。"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import webbrowser
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

from .core import autostart, envfile
from .core.config import APP_NAME, APP_VERSION, app_dir
from .core.logs import LogStore
from .core.plugins import PluginHost
from .core.process import BotProcess

ANIMATIONS = [
    {"id": "smooth", "name": "丝滑淡入", "desc": "8px 上浮 + 柔和缓动，最耐看"},
    {"id": "spring", "name": "弹性回弹", "desc": "带轻微 overshoot，手感活泼"},
    {"id": "glass", "name": "玻璃柔光", "desc": "毛玻璃面板 + 背景柔光"},
    {"id": "none", "name": "极简零动画", "desc": "全部瞬时切换，最跟手"},
]

ENV_FIELDS = [
    {"key": "FEISHU_APP_ID", "label": "飞书 App ID", "placeholder": "cli_xxxxxxxx", "group": "飞书"},
    {"key": "FEISHU_APP_SECRET", "label": "飞书 App Secret", "secret": True, "group": "飞书"},
    {"key": "DEEPSEEK_MODEL", "label": "模型", "placeholder": "deepseek-flash", "group": "模型"},
    {"key": "DEEPSEEK_BASE_URL", "label": "接口地址", "placeholder": "https://api.deepseek.com", "group": "模型"},
    {"key": "DEEPSEEK_API_KEY", "label": "API Key", "secret": True, "group": "模型"},
    {"key": "BOT_NAME", "label": "机器人名字", "group": "人设"},
    {"key": "SYSTEM_PROMPT", "label": "人设提示词", "multiline": True, "group": "人设"},
    {"key": "MAX_HISTORY_TURNS", "label": "上下文轮数", "placeholder": "6", "group": "人设"},
]

# 无边框窗口「拖边改大小」用：边/角 → Win32 命中测试码
RESIZE_HIT = {
    "left": 10,  # HTLEFT
    "right": 11,  # HTRIGHT
    "top": 12,  # HTTOP
    "topleft": 13,  # HTTOPLEFT
    "topright": 14,  # HTTOPRIGHT
    "bottom": 15,  # HTBOTTOM
    "bottomleft": 16,  # HTBOTTOMLEFT
    "bottomright": 17,  # HTBOTTOMRIGHT
}

# 链接里的类型段 → (中文名, 机器人是否支持读写)
DOC_TYPES = {
    "docx": ("文档", True),
    "wiki": ("知识库", True),
    "sheets": ("电子表格", True),
    "base": ("多维表格", False),
    "mindnotes": ("思维笔记", False),
    "slides": ("幻灯片", False),
    "docs": ("旧版文档", False),
}


class Api:
    def __init__(self, config, logs: LogStore, bot: BotProcess, plugins: PluginHost) -> None:
        self._config = config
        self._logs = logs
        self._bot = bot
        self._plugins = plugins
        self._window = None
        self._maximized = False

    # ------------------------------------------------------------------ 启动
    def bootstrap(self) -> Dict[str, Any]:
        return {
            "app": {"name": APP_NAME, "version": APP_VERSION, "frozen": bool(getattr(sys, "frozen", False))},
            "config": self._config.data,
            "status": self._bot.status(),
            "preflight": self._bot.preflight(),
            "animations": ANIMATIONS,
            "envFields": ENV_FIELDS,
            "plugins": self._plugins.list(),
            "autostart": autostart.is_enabled(),
            "platform": {"os": os.name, "py": sys.version.split()[0]},
        }

    def get_status(self) -> Dict[str, Any]:
        return self._bot.status()

    def get_preflight(self) -> Dict[str, Any]:
        return self._bot.preflight()

    # ------------------------------------------------------------------ 进程
    def start_bot(self) -> Dict[str, Any]:
        return self._bot.start()

    def stop_bot(self) -> Dict[str, Any]:
        return self._bot.stop()

    def restart_bot(self) -> Dict[str, Any]:
        return self._bot.restart()

    # ------------------------------------------------------------------ 日志
    def get_logs(self, last_id: int = 0) -> List[Dict[str, Any]]:
        return self._logs.since(int(last_id or 0))

    def clear_logs(self) -> bool:
        self._logs.clear()
        return True

    def export_logs(self) -> Dict[str, Any]:
        try:
            path = self._logs.export()
            self._logs.add(f"日志已导出：{path}", "manager")
            return {"ok": True, "path": path}
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    # ------------------------------------------------------------------ 配置
    def save_settings(self, patch: Dict[str, Any]) -> Dict[str, Any]:
        data = self._config.update(patch or {})
        self._logs.add("设置已保存", "manager")
        return {"ok": True, "config": data}

    def pick_folder(self) -> Optional[str]:
        try:
            import webview

            result = self._window.create_file_dialog(webview.FOLDER_DIALOG, directory=str(app_dir()))
            if result:
                return result[0] if isinstance(result, (list, tuple)) else str(result)
        except Exception:
            pass
        return None

    def use_bundled_bot(self) -> Dict[str, Any]:
        """把机器人目录切到安装包里自带的那份（<exe 目录>\\bot）。"""
        bundled = app_dir() / "bot"
        if not (bundled / "index.js").exists():
            return {
                "ok": False,
                "error": "这一版没有内置机器人，请手动选一个包含 index.js 的目录",
            }
        self._config.set("bot.dir", str(bundled))
        self._config.save()
        self._logs.add(f"机器人目录已切到内置副本：{bundled}", "manager")
        return {"ok": True, "dir": str(bundled)}

    def open_path(self, path: str) -> bool:
        try:
            if os.path.exists(path):
                os.startfile(path)  # type: ignore[attr-defined]
                return True
        except Exception as exc:
            self._logs.add(f"打开路径失败：{exc}", "manager", "warn")
        return False

    # ------------------------------------------------------------ 飞书后台入口

    def feishu_console_url(self) -> dict:
        """飞书开放平台地址：能读到 App ID 就直达该应用的「凭证与基础信息」。"""
        app_id = ""
        try:
            env = self.get_env()
            if env.get("ok"):
                app_id = str((env.get("values") or {}).get("FEISHU_APP_ID", "")).strip()
        except Exception:
            app_id = ""
        if re.fullmatch(r"[A-Za-z0-9_-]{6,64}", app_id or ""):
            return {"ok": True, "url": f"https://open.feishu.cn/app/{app_id}/baseinfo", "exact": True}
        return {"ok": True, "url": "https://open.feishu.cn/app", "exact": False}

    def open_feishu_console(self) -> dict:
        """在系统浏览器里打开飞书开放平台（应用凭证页）。"""
        info = self.feishu_console_url()
        try:
            os.startfile(info["url"])
        except Exception as exc:
            self._logs.add(f"打不开飞书开放平台：{exc}", "manager", "error")
            return {"ok": False, "error": f"打不开浏览器：{exc}", "url": info["url"]}
        return info

    def open_url(self, url: str) -> bool:
        if not str(url).startswith(("http://", "https://")):
            return False
        webbrowser.open(url)
        return True

    # ------------------------------------------------------------------ env
    def _require_bot_dir(self) -> Optional[Dict[str, Any]]:
        """写文件前确认机器人目录已配置。

        目录为空时 Path('') / '.env' 会变成相对路径，等于写到 exe 旁边去，
        所以这里先拦一道，返回错误体给前端；没问题返回 None。
        """
        if str(self._config.get("bot.dir", "")).strip():
            return None
        return {"ok": False, "error": "还没设置机器人目录，先到「设置」里选一下再保存"}

    def get_env(self) -> Dict[str, Any]:
        path = Path(self._config.get("bot.dir", "")) / ".env"
        raw = ""
        exists = path.exists()
        if exists:
            try:
                raw = path.read_text(encoding="utf-8")
            except Exception as exc:
                return {"ok": False, "error": str(exc), "path": str(path)}
        return {
            "ok": True,
            "path": str(path),
            "exists": exists,
            "raw": raw,
            "values": envfile.parse(raw),
        }

    def save_env(self, patch: Dict[str, str]) -> Dict[str, Any]:
        guard = self._require_bot_dir()
        if guard:
            return guard
        info = self.get_env()
        if not info.get("ok"):
            return info
        path = Path(info["path"])
        new_text = envfile.merge(info["raw"], {k: ("" if v is None else str(v)) for k, v in (patch or {}).items()})
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(new_text, encoding="utf-8")
            self._logs.add(f"已保存 {len(patch or {})} 项配置到 .env", "manager")
            return {"ok": True, "values": envfile.parse(new_text)}
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    def save_env_raw(self, text: str) -> Dict[str, Any]:
        guard = self._require_bot_dir()
        if guard:
            return guard
        info = self.get_env()
        if not info.get("ok"):
            return info
        try:
            Path(info["path"]).write_text(text, encoding="utf-8")
            return {"ok": True}
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    # ------------------------------------------------------------------ 文档清单
    def _docs_path(self) -> Path:
        return Path(self._config.get("bot.dir", "")) / "docs.json"

    def _load_docs_data(self) -> Dict[str, Any]:
        path = self._docs_path()
        if not path.exists():
            return {"docs": [], "folders": []}
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return {"docs": [], "folders": []}
        if not isinstance(data, dict):
            return {"docs": [], "folders": []}
        data.setdefault("docs", [])
        data.setdefault("folders", [])
        if not isinstance(data["docs"], list):
            data["docs"] = []
        return data

    def _save_docs_data(self, data: Dict[str, Any]) -> None:
        path = self._docs_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )

    def _parse_doc_url(self, raw: str) -> Optional[Dict[str, Any]]:
        """从链接里认出文档类型和 token。

        返回 {url, type, token, docType, supported, hint}；认不出来返回 None。
        """
        s = (raw or "").strip().strip('"').strip("'")
        if not s:
            return None

        m = re.search(r"/(docx|wiki|sheets|base|mindnotes|slides|docs)/([A-Za-z0-9]+)", s)
        if m:
            kind, token = m.group(1), m.group(2)
        elif re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]{14,}", s):
            kind, token = "docx", s  # 裸 token 当文档处理，类型要等实际调用才知道
        else:
            return None

        label = DOC_TYPES.get(kind, ("未知类型", False))[0]
        supported = DOC_TYPES.get(kind, ("", False))[1]
        hint = ""
        if kind == "wiki":
            # 知识库节点背后可能是文档、表格或多维表格，光看链接无法确定
            if "sheet=" in s or "table=" in s:
                hint = "知识库里的电子表格：可以按关键词读行，写入暂未开放"
            else:
                hint = "知识库节点，机器人会自动解析成对应的文档或表格"
        elif not supported:
            hint = f"{label}类型机器人暂不支持，只能登记不参与读写"

        return {
            "url": s,
            "type": kind,
            "token": token,
            "docType": label,
            "supported": supported,
            "hint": hint,
        }

    def list_docs(self) -> Dict[str, Any]:
        data = self._load_docs_data()
        docs = []
        for i, d in enumerate(data["docs"]):
            if not isinstance(d, dict):
                continue
            parsed = self._parse_doc_url(d.get("url") or d.get("token") or "")
            docs.append(
                {
                    "index": i,
                    "name": d.get("name") or f"文档 {i + 1}",
                    "url": d.get("url") or d.get("token", ""),
                    "token": (parsed or {}).get("token", ""),
                    "docType": (parsed or {}).get("docType", "未知"),
                    "writable": bool(d.get("writable", True)),
                    "note": d.get("note", ""),
                }
            )
        return {"ok": True, "path": str(self._docs_path()), "docs": docs}

    def add_doc(self, url: str, name: str = "", writable: bool = True) -> Dict[str, Any]:
        parsed = self._parse_doc_url(url)
        if not parsed:
            return {
                "ok": False,
                "error": "认不出这个链接，请粘贴完整地址（含 /docx/ 或 /wiki/ 那一段）",
            }

        data = self._load_docs_data()
        for d in data["docs"]:
            if not isinstance(d, dict):
                continue
            exist = self._parse_doc_url(d.get("url") or d.get("token") or "")
            if exist and exist["token"] == parsed["token"]:
                return {"ok": False, "error": "这篇文档已经在清单里了"}

        entry = {
            "name": (name or "").strip() or f"文档 {len(data['docs']) + 1}",
            "type": "wiki" if parsed["type"] == "wiki" else "docx",
            "url": parsed["url"],
            "writable": bool(writable),
        }
        data["docs"].append(entry)
        try:
            self._save_docs_data(data)
        except Exception as exc:
            return {"ok": False, "error": f"写入 docs.json 失败：{exc}"}

        self._logs.add(f"文档清单新增：{entry['name']}", "manager")
        result = self.list_docs()
        result.update({"added": entry, "hint": parsed["hint"], "supported": parsed["supported"]})
        return result

    def remove_doc(self, index: int) -> Dict[str, Any]:
        data = self._load_docs_data()
        try:
            removed = data["docs"].pop(int(index))
        except Exception:
            return {"ok": False, "error": "这一项不存在，刷新一下列表"}
        try:
            self._save_docs_data(data)
        except Exception as exc:
            return {"ok": False, "error": f"写入 docs.json 失败：{exc}"}
        self._logs.add(f"文档清单移除：{removed.get('name', '')}", "manager")
        return self.list_docs()

    def rename_doc(self, index: int, name: str) -> Dict[str, Any]:
        data = self._load_docs_data()
        try:
            data["docs"][int(index)]["name"] = (name or "").strip()
        except Exception:
            return {"ok": False, "error": "这一项不存在，刷新一下列表"}
        try:
            self._save_docs_data(data)
        except Exception as exc:
            return {"ok": False, "error": f"写入 docs.json 失败：{exc}"}
        return self.list_docs()

    def set_doc_writable(self, index: int, writable: bool) -> Dict[str, Any]:
        data = self._load_docs_data()
        try:
            data["docs"][int(index)]["writable"] = bool(writable)
        except Exception:
            return {"ok": False, "error": "这一项不存在，刷新一下列表"}
        try:
            self._save_docs_data(data)
        except Exception as exc:
            return {"ok": False, "error": f"写入 docs.json 失败：{exc}"}
        return self.list_docs()

    def get_docs(self) -> Dict[str, Any]:
        path = self._docs_path()
        raw = "{\n  \"docs\": [],\n  \"folders\": []\n}\n"
        if path.exists():
            try:
                raw = path.read_text(encoding="utf-8")
            except Exception as exc:
                return {"ok": False, "error": str(exc), "path": str(path)}
        return {"ok": True, "path": str(path), "raw": raw}

    def save_docs(self, text: str) -> Dict[str, Any]:
        try:
            json.loads(text)
        except Exception as exc:
            return {"ok": False, "error": f"JSON 格式不对：{exc}"}
        info = self.get_docs()
        try:
            Path(info["path"]).write_text(text, encoding="utf-8")
            return {"ok": True}
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    # ------------------------------------------------------------------ 导入 / 导出
    def _dialog(self, kind, **kwargs) -> Optional[str]:
        """弹系统文件对话框，拿一个路径。取消或失败都返回 None。"""
        if not self._window:
            return None
        try:
            res = self._window.create_file_dialog(kind, **kwargs)
        except Exception as exc:
            self._logs.add(f"文件对话框打开失败：{exc}", "manager", "warn")
            return None
        if not res:
            return None
        if isinstance(res, (list, tuple)):
            return str(res[0]) if res else None
        return str(res)

    def export_config(self) -> Dict[str, Any]:
        """把 .env 和 docs.json 打包成一个 JSON，方便换机器 / 备份。"""
        import webview

        info = self.get_env()
        if not info.get("ok"):
            return info

        docs = None
        docs_path = Path(info["path"]).parent / "docs.json"
        if docs_path.exists():
            try:
                docs = json.loads(docs_path.read_text(encoding="utf-8"))
            except Exception:
                docs = None

        target = self._dialog(
            webview.SAVE_DIALOG,
            save_filename=f"feishu-bot-config-{datetime.now():%Y%m%d}.json",
            file_types=("配置文件 (*.json)", "所有文件 (*.*)"),
        )
        if not target:
            return {"ok": False, "canceled": True}
        if not target.lower().endswith(".json"):
            target += ".json"

        payload = {
            "app": "FeishuBotManager",
            "version": 1,
            "exportedAt": datetime.now().isoformat(timespec="seconds"),
            "env": info.get("values") or {},
            "docs": docs,
        }
        try:
            Path(target).write_text(
                json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
            )
        except Exception as exc:
            return {"ok": False, "error": f"写入失败：{exc}"}

        count = len(payload["env"])
        self._logs.add(f"已导出配置（{count} 项）→ {target}", "manager")
        return {"ok": True, "path": target, "count": count}

    def import_config(self) -> Dict[str, Any]:
        """从导出的 JSON 读回配置，只覆盖文件里出现的键。"""
        import webview

        src = self._dialog(
            webview.OPEN_DIALOG,
            allow_multiple=False,
            file_types=("配置文件 (*.json)", "所有文件 (*.*)"),
        )
        if not src:
            return {"ok": False, "canceled": True}

        try:
            data = json.loads(Path(src).read_text(encoding="utf-8"))
        except Exception as exc:
            return {"ok": False, "error": f"读不出来：{exc}"}

        env = data.get("env")
        if not isinstance(env, dict) or not env:
            return {"ok": False, "error": "文件里没有 env 字段，不像是导出的配置"}

        patch = {str(k): "" if v is None else str(v) for k, v in env.items()}
        res = self.save_env(patch)
        if not (res and res.get("ok")):
            return res or {"ok": False, "error": "写入 .env 失败"}

        docs_written = None
        docs = data.get("docs")
        if isinstance(docs, dict):
            try:
                info = self.get_docs()
                Path(info["path"]).write_text(
                    json.dumps(docs, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
                )
                docs_written = True
            except Exception:
                docs_written = False

        self._logs.add(f"已导入配置（{len(patch)} 项）← {src}", "manager")
        return {
            "ok": True,
            "count": len(patch),
            "keys": sorted(patch.keys()),
            "docs": docs_written,
            "path": src,
        }

    # ------------------------------------------------------------------ 界面
    def set_ui(self, patch: Dict[str, Any]) -> Dict[str, Any]:
        self._config.update({"ui": patch or {}})
        return {"ok": True, "ui": self._config.get("ui")}

    def set_close_action(self, action: str) -> Dict[str, Any]:
        """关闭窗口时的行为：tray = 收进托盘，quit = 直接退出。"""
        value = "quit" if str(action) == "quit" else "tray"
        self._config.set("window.closeAction", value)
        self._config.save()
        self._logs.add(f"关闭窗口行为已改为：{'隐藏到托盘' if value == 'tray' else '退出应用'}", "manager")
        return {"ok": True, "action": value}

    def set_autostart(self, enabled: bool) -> Dict[str, Any]:
        ok = autostart.set_enabled(bool(enabled))
        self._logs.add(f"开机自启已{'开启' if enabled else '关闭'}", "manager")
        return {"ok": ok, "enabled": autostart.is_enabled()}

    # ------------------------------------------------------------------ 插件
    def plugin_list(self) -> List[Dict[str, Any]]:
        return self._plugins.list()

    def plugin_ui(self) -> List[Dict[str, Any]]:
        return self._plugins.ui_payload()

    def plugin_call(self, pid: str, method: str, payload: Any = None) -> Dict[str, Any]:
        return self._plugins.call(pid, method, payload)

    def plugin_toggle(self, pid: str, enabled: bool) -> Dict[str, Any]:
        self._plugins.set_enabled(pid, bool(enabled))
        return {"ok": True, "plugins": self._plugins.list()}

    def open_plugins_dir(self) -> bool:
        return self.open_path(str(self._plugins.dir))

    def reload_plugins(self) -> Dict[str, Any]:
        self._plugins.reload()
        return {"ok": True, "plugins": self._plugins.list(), "ui": self._plugins.ui_payload()}

    def import_plugin_drop(self, items: List[Dict[str, Any]]) -> Dict[str, Any]:
        """把界面拖进来的插件（文件夹或 .zip）装进 plugins/。

        浏览器侧只能拿到文件内容（拿不到绝对路径），所以界面把每个文件转成 base64 传上来，
        落地、校验、查重都在 PluginHost 里做，这里只做转发。
        """
        return self._plugins.import_dropped(items or [])

    # ------------------------------------------------------------------ 窗口
    def _native_form(self):
        """拿到承载 WebView 的 WinForms Form。

        pywebview 在 winforms 后端里把 Form 挂在 window.native 上
        （不是 window.gui，gui 是后端模块）。两个都兜一下。
        """
        win = self._window
        if not win:
            return None
        form = getattr(win, "native", None)
        if form is None:
            form = getattr(getattr(win, "gui", None), "form", None)
        return form

    def win_minimize(self) -> None:
        if self._window:
            self._window.minimize()

    def _is_maximized(self) -> bool:
        """以窗口真实状态为准。

        Aero snap、拖到屏幕顶部、Win+↑ 都不会经过 win_toggle_max，
        只靠一个标志位会失真，所以优先问 WinForms 要状态。
        """
        form = self._native_form()
        if form is not None and os.name == "nt":
            try:
                from System.Windows.Forms import FormWindowState  # type: ignore

                return form.WindowState == FormWindowState.Maximized
            except Exception:
                pass
        return self._maximized

    def win_toggle_max(self) -> None:
        if not self._window:
            return
        form = self._native_form()
        if form is not None and os.name == "nt":
            try:
                from System.Windows.Forms import Screen  # type: ignore

                form.MaximizedBounds = Screen.FromControl(form).WorkingArea
            except Exception:
                pass  # 设不了就按默认，顶多最大化时盖住任务栏
        try:
            if self._is_maximized():
                self._window.restore()
                self._maximized = False
            else:
                self._window.maximize()
                self._maximized = True
        except Exception as exc:
            self._logs.add(f"窗口最大化失败：{exc}", "manager", "warn")

    def _start_system_drag(self, hit_code: int) -> None:
        """把拖拽交给系统原生循环：ReleaseCapture + WM_NCLBUTTONDOWN。

        hit_code 决定是「移动」（HTCAPTION）还是「改大小」（HTLEFT/HTTOP…）。
        必须让这两步跑在 UI 线程上（鼠标捕获属于那个线程），所以用 form.BeginInvoke
        投递过去；投递不了就直接调，至少不会完全没反应。
        """
        if os.name != "nt":
            return
        form = self._native_form()
        if form is None:
            self._logs.add("窗口拖动失败：拿不到窗口句柄", "manager", "warn")
            return

        try:
            import ctypes

            hwnd = int(form.Handle.ToInt64())
            user32 = ctypes.windll.user32

            def run():
                # 最大化时先还原：否则从屏幕边缘拉只会被系统忽略
                try:
                    from System.Windows.Forms import FormWindowState  # type: ignore

                    if form.WindowState == FormWindowState.Maximized:
                        form.WindowState = FormWindowState.Normal
                        self._maximized = False
                except Exception:
                    pass
                user32.ReleaseCapture()
                user32.SendMessageW(hwnd, 0xA1, hit_code, 0)

            try:
                from System import Action  # type: ignore

                form.BeginInvoke(Action(run))
            except Exception:
                run()
        except Exception as exc:
            self._logs.add(f"窗口拖动失败：{exc}", "manager", "warn")

    def win_drag(self) -> None:
        """标题栏拖拽改位置。"""
        self._start_system_drag(2)  # HTCAPTION

    def win_resize(self, edge: str) -> None:
        """贴边拖拽改大小。

        edge 取 left / right / top / bottom / topleft / topright / bottomleft / bottomright，
        由界面上的 8 个热区传入；认不出就什么都不做。
        """
        code = RESIZE_HIT.get(str(edge or "").strip().lower())
        if code is None:
            return
        self._start_system_drag(code)

    def win_hide(self) -> None:
        """点标题栏的 × 或「收进托盘」：默认隐藏窗口；设置成「退出应用」时直接退出。"""
        if str(self._config.get("window.closeAction", "tray")) == "quit":
            self._logs.add("关闭窗口：按设置直接退出", "manager", "info")
            self.quit_app()
            return
        self._logs.add("关闭窗口：收进托盘", "manager", "info")
        if self._window:
            self._window.hide()

    def win_close(self) -> None:
        """真正退出（和标题栏的「收进托盘」不同）。"""
        self.quit_app()

    def quit_app(self) -> None:
        hook = getattr(self, "quit_hook", None)
        if hook:
            hook()
            return
        if self._window:
            self._window.destroy()

    # ------------------------------------------------------------------ 杂项
    def reveal_env(self) -> bool:
        """在资源管理器里定位 .env；文件还不存在时退回打开所在目录。"""
        path = Path(self._config.get("bot.dir", "")) / ".env"
        if path.exists() and os.name == "nt":
            try:
                subprocess.Popen(["explorer", f"/select,{path}"])
                return True
            except Exception as exc:
                self._logs.add(f"定位 .env 失败：{exc}", "manager", "warn")
        return self.open_path(str(path.parent))

    def copy_text(self, text: str) -> bool:
        try:
            if os.name == "nt":
                subprocess.run("clip", input=str(text), text=True, shell=True, check=False)
                return True
        except Exception:
            pass
        return False
