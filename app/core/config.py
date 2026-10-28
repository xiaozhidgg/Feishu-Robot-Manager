"""运行时路径与配置读写。"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any, Dict

APP_NAME = "FeishuBotManager"
APP_VERSION = "1.0.1"


def is_frozen() -> bool:
    return bool(getattr(sys, "frozen", False))


def app_dir() -> Path:
    """可写目录：打包后是 exe 所在目录，开发时是项目根目录。"""
    if is_frozen():
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parents[2]


def res_dir() -> Path:
    """只读资源目录：打包后是 PyInstaller 的临时解压目录。"""
    if is_frozen():
        return Path(getattr(sys, "_MEIPASS", app_dir()))
    return Path(__file__).resolve().parents[1]


def web_dir() -> Path:
    """前端资源目录（开发时 app/web，打包后 _MEIPASS/web）。"""
    if is_frozen():
        return Path(getattr(sys, "_MEIPASS", app_dir())) / "web"
    return Path(__file__).resolve().parents[1] / "web"


CONFIG_PATH = app_dir() / "manager.config.json"

DEFAULTS: Dict[str, Any] = {
    "bot": {
        "dir": "",
        "node": "node",
        "autoStart": False,
        "stopOnExit": True,
    },
    "ui": {
        "animation": "smooth",
        "theme": "dark",
        "accent": "#0a8f47",
    },
    "window": {
        "frameless": True,
        "width": 1120,
        "height": 760,
        "closeAction": "tray",
    },
    "log": {
        "maxLines": 3000,
        "keepDays": 14,
    },
    "plugins": {
        "disabled": [],
    },
}


def _deep_merge(base: Dict[str, Any], patch: Dict[str, Any]) -> Dict[str, Any]:
    out = dict(base)
    for k, v in (patch or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _deep_merge(out[k], v)
        else:
            out[k] = v
    return out


def guess_bot_dir() -> str:
    """首次运行时猜一下机器人目录，省得用户手填。

    优先找 exe 同级，再逐级往上翻兄弟目录（exe 通常在 dist 里，机器人是它的
    叔伯目录），最后才是几个常见位置。
    """
    root = app_dir()
    # 安装包会把机器人放在 安装目录下的 bot 子目录，这里排第一，装完就能直接用
    candidates = [root / "bot", root / "feishu-deepseek-bot"]

    cur = root
    for _ in range(4):  # dist → FeishuBotManager → 上一级 → 再上一级 …
        cur = cur.parent
        candidates.append(cur / "feishu-deepseek-bot")

    home = Path.home()
    candidates += [
        home / "Desktop" / "feishu-deepseek-bot",
    ]

    # 再往下翻两层：常见的「桌面\项目\feishu-deepseek-bot」布局。
    # 只在首次运行（配置里还没有目录）时执行，限制扫描量避免拖慢启动。
    scanned = 0
    for base in (
        home / "Desktop", home / "桌面",
        home / "Downloads", home / "下载",
        home / "Documents", home / "文档",
    ):
        if not base.is_dir():
            continue
        for depth in (1, 2):
            pattern = "/".join(["*"] * depth + ["feishu-deepseek-bot"])
            try:
                for c in base.glob(pattern):
                    scanned += 1
                    if scanned > 400:
                        break
                    candidates.append(c)
            except OSError:
                continue
            if scanned > 400:
                break
        if scanned > 400:
            break

    for c in candidates:
        try:
            if (c / "index.js").exists():
                return str(c)
        except OSError:
            continue
    return ""


class Config:
    def __init__(self) -> None:
        self.data: Dict[str, Any] = json.loads(json.dumps(DEFAULTS))
        self.load()

    def load(self) -> Dict[str, Any]:
        if CONFIG_PATH.exists():
            try:
                raw = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
                self.data = _deep_merge(DEFAULTS, raw)
            except Exception:
                self.data = json.loads(json.dumps(DEFAULTS))
        if not self.data["bot"].get("dir"):
            self.data["bot"]["dir"] = guess_bot_dir()
        return self.data

    def save(self) -> None:
        tmp = CONFIG_PATH.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(self.data, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(tmp, CONFIG_PATH)

    def get(self, path: str, default: Any = None) -> Any:
        cur: Any = self.data
        for part in path.split("."):
            if not isinstance(cur, dict) or part not in cur:
                return default
            cur = cur[part]
        return cur

    def set(self, path: str, value: Any) -> None:
        parts = path.split(".")
        cur = self.data
        for part in parts[:-1]:
            cur = cur.setdefault(part, {})
        cur[parts[-1]] = value

    def update(self, patch: Dict[str, Any]) -> Dict[str, Any]:
        self.data = _deep_merge(self.data, patch or {})
        self.save()
        return self.data
