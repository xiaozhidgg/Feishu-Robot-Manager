"""安装程序入口：向导界面 + 静默模式。

双击 = 图形向导；带 --silent 则无界面安装（调试/批量用）。
"""
from __future__ import annotations

import os
import sys
import threading
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import core  # noqa: E402

try:
    import webview  # noqa: E402
except Exception:  # 静默模式下不需要界面
    webview = None


class Api:
    def __init__(self) -> None:
        self._window = None
        found = core.detect_install()
        self._installed = found
        self._target = Path(found["path"]) if found["found"] else core.default_dir()
        self._job = {"running": False, "pct": 0, "text": "", "done": False, "error": "", "target": ""}
        self._lock = threading.Lock()
        self._closed = False

    # ------------------------------------------------------------------ 信息
    def info(self) -> dict:
        st = core.dir_status(self._target)
        return {
            "name": core.APP_NAME,
            "version": core.APP_VERSION,
            "publisher": core.PUBLISHER,
            "defaultDir": str(self._target),
            "needMB": st["needMB"],
            "freeMB": st["freeMB"],
            "isAdmin": self._is_admin(),
            "installed": self._installed,
            "running": core.is_running(),
        }

    @staticmethod
    def _is_admin() -> bool:
        try:
            import ctypes

            return bool(ctypes.windll.shell32.IsUserAnAdmin())
        except Exception:
            return False

    def status(self, path: str) -> dict:
        """检查「将要安装到」的位置（已补上 FeishuBotManager 子目录）。"""
        st = core.dir_status(core.resolve_target(path))
        return st

    def browse(self, current: str = "") -> str | None:
        """系统文件夹选择框。"""
        if not self._window or webview is None:
            return None
        try:
            start = current if os.path.isdir(current) else str(self._target)
            res = self._window.create_file_dialog(webview.FOLDER_DIALOG, directory=start)
        except Exception:
            return None
        if not res:
            return None
        picked = res[0] if isinstance(res, (list, tuple)) else res
        if not picked:
            return None
        # 选中的只是父目录，这里就把软件文件夹补上，输入框里直接显示真实安装位置
        return str(core.resolve_target(picked))

    # ------------------------------------------------------------------ 安装
    def start(self, path: str, opts: dict | None = None) -> dict:
        opts = opts or {}
        if not path.strip():
            return {"ok": False, "error": "安装位置不能为空"}
        if core.is_running():
            return {
                "ok": False,
                "error": "管家正在运行。请右键托盘图标选「退出」，再点安装。",
            }
        target = core.resolve_target(path)

        with self._lock:
            if self._job["running"]:
                return {"ok": False, "error": "正在安装中"}
            self._job = {"running": True, "pct": 0, "text": "开始…", "done": False, "error": "", "target": str(target)}

        def work():
            def progress(pct: int, text: str) -> None:
                with self._lock:
                    self._job["pct"] = pct
                    self._job["text"] = text

            try:
                core.install(
                    target,
                    desktop=bool(opts.get("desktop", True)),
                    start_menu=bool(opts.get("startMenu", True)),
                    registry=bool(opts.get("registry", True)),
                    progress=progress,
                )
                with self._lock:
                    self._job.update(running=False, done=True, pct=100, text="安装完成")
            except Exception as exc:
                with self._lock:
                    self._job.update(
                        running=False, done=True, error=str(exc).replace("\n", " "), text="安装失败"
                    )

        threading.Thread(target=work, daemon=True).start()
        return {"ok": True}

    def progress(self) -> dict:
        with self._lock:
            return dict(self._job)

    # ------------------------------------------------------------------ 收尾
    def open_app(self, path: str) -> bool:
        try:
            core.launch(Path(path))
            return True
        except Exception:
            return False

    def open_folder(self, path: str) -> bool:
        try:
            os.startfile(path)  # type: ignore[attr-defined]
            return True
        except Exception:
            return False

    def close(self) -> None:
        self._closed = True
        if self._window:
            self._window.destroy()


def run_silent(argv: list[str]) -> int:
    explicit = _arg(argv, "--dir")
    if explicit:
        target = core.resolve_target(explicit)
    else:
        found = core.detect_install()
        # 已经装过就默认覆盖到原位置，别在别的盘再装一份
        target = Path(found["path"]) if found["found"] else core.resolve_target(core.default_dir())
    core.install(
        target,
        desktop="--no-shortcuts" not in argv,
        start_menu="--no-shortcuts" not in argv,
        registry="--no-registry" not in argv,
        progress=lambda pct, text: print(f"{pct:3d}% {text}"),
    )
    print(f"installed -> {target}")
    return 0


def _arg(argv: list[str], name: str) -> str | None:
    for i, a in enumerate(argv):
        if a == name and i + 1 < len(argv):
            return argv[i + 1]
        if a.startswith(name + "="):
            return a.split("=", 1)[1]
    return None


def run_wizard() -> int:
    if webview is None:
        return run_silent(sys.argv[1:])

    api = Api()
    index = core.web_dir() / "index.html"
    window = webview.create_window(
        title=f"{core.APP_NAME} 安装向导",
        url=str(index),
        js_api=api,
        width=800,
        height=640,
        resizable=True,
        min_size=(720, 540),
        background_color="#0b0d0f",
        text_select=False,
    )
    api._window = window
    webview.start(gui="edgechromium", private_mode=True, storage_path=str(Path(os.environ.get("TEMP", ".")) / "fbm-setup-cache"))
    return 0


if __name__ == "__main__":
    try:
        if "--silent" in sys.argv[1:]:
            raise SystemExit(run_silent(sys.argv[1:]))
        raise SystemExit(run_wizard())
    except SystemExit:
        raise
    except Exception as exc:
        detail = traceback.format_exc()
        try:
            Path(os.environ.get("TEMP", "."), "fbm-setup-error.log").write_text(detail, encoding="utf-8")
        except Exception:
            pass
        try:
            import ctypes

            ctypes.windll.user32.MessageBoxW(None, f"安装程序出错：{exc}", core.APP_NAME, 0x10)
        except Exception:
            print(detail)
        raise SystemExit(1)
