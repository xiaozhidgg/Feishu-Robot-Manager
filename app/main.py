"""程序入口：单实例、窗口、托盘、生命周期。"""
from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

import webview

from .api import Api
from .core.config import APP_NAME, app_dir, web_dir
from .core.logs import LogStore
from .core.plugins import PluginHost
from .core.process import BotProcess

MUTEX_NAME = "Global\\FeishuBotManager_SingleInstance"


def _already_running() -> bool:
    if os.name != "nt":
        return False
    import ctypes

    kernel32 = ctypes.windll.kernel32
    kernel32.CreateMutexW(None, False, MUTEX_NAME)
    return kernel32.GetLastError() == 183  # ERROR_ALREADY_EXISTS


def _message_box(text: str, title: str = APP_NAME) -> None:
    if os.name != "nt":
        print(f"{title}: {text}")
        return
    import ctypes

    ctypes.windll.user32.MessageBoxW(None, text, title, 0x10)


def _make_tray_image():
    """不用外部图片文件，运行时画一个图标，省得打包漏资源。"""
    try:
        from PIL import Image, ImageDraw
    except Exception:
        return None
    size = 64
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([2, 2, size - 3, size - 3], radius=16, fill=(10, 143, 71, 255))
    d.rounded_rectangle([14, 18, 50, 40], radius=8, fill=(255, 255, 255, 235))
    d.polygon([(22, 40), (22, 50), (33, 40)], fill=(255, 255, 255, 235))
    return img


def _confirm(text: str, title: str = APP_NAME) -> bool:
    """是/否对话框（默认「否」）。"""
    if os.name != "nt":
        return input(f"{title}: {text} [y/N] ").strip().lower() == "y"
    import ctypes

    return ctypes.windll.user32.MessageBoxW(None, text, title, 0x04 | 0x40) == 6  # MB_YESNO | MB_ICONINFORMATION


def _ensure_dirs() -> None:
    """先把运行期目录建出来：装完打开就能看到 logs/plugins，不用等第一条日志。"""
    for path in (app_dir() / "logs", app_dir() / "plugins", app_dir() / ".webview"):
        try:
            path.mkdir(parents=True, exist_ok=True)
        except OSError:
            pass


def _desktop_dir() -> Path:
    """桌面可能被重定向（D:/Desktop / OneDrive），按注册表找真实位置。"""
    try:
        import winreg

        with winreg.OpenKey(
            winreg.HKEY_CURRENT_USER,
            r"Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders",
        ) as k:
            raw, _ = winreg.QueryValueEx(k, "Desktop")
        path = Path(os.path.expandvars(str(raw)))
        if path.is_dir():
            return path
    except Exception:
        pass
    return Path.home() / "Desktop"


def _remove_shortcuts() -> None:
    # 安装器用的是中文显示名，主程序里的 APP_NAME 是英文内部名，两个都要扫
    names = ("飞书机器人管家", "FeishuBotManager")
    folders = [_desktop_dir(), Path.home() / "Desktop"]
    appdata = os.environ.get("APPDATA")
    if appdata:
        folders.append(Path(appdata) / "Microsoft" / "Windows" / "Start Menu" / "Programs")
    for folder in folders:
        for name in names:
            for lnk in (folder / f"{name}.lnk", folder / f"卸载 {name}.lnk"):
                try:
                    lnk.unlink()
                except OSError:
                    pass


def _remove_registry() -> None:
    if os.name != "nt":
        return
    try:
        import winreg

        winreg.DeleteKey(
            winreg.HKEY_CURRENT_USER,
            r"Software\Microsoft\Windows\CurrentVersion\Uninstall\FeishuBotManager",
        )
    except OSError:
        pass


def _run_uninstall(ask: bool = True) -> None:
    """`--uninstall`：注册表和快捷方式当场清掉，目录交给一个等进程退出的 cmd 删。

    Windows 上删不掉正在运行的 exe，所以写个临时脚本：等 1 秒 → 杀掉管家 →
    重试 rd 最多 20 次 → 自删。这样安装包里就不用再塞一个 8MB 的卸载器。
    """
    target = app_dir()
    if ask and not _confirm(
        f"要卸载「{APP_NAME}」吗？\n\n安装目录：{target}\n\n"
        "（配置、日志和插件会一起删除；机器人项目的 .env 不受影响）"
    ):
        return

    _remove_registry()
    _remove_shortcuts()

    temp = Path(tempfile.gettempdir())
    script = temp / "fbm-uninstall.cmd"
    body = (
        "@echo off\r\n"
        "timeout /t 1 /nobreak >nul\r\n"
        'taskkill /f /im "FeishuBotManager.exe" >nul 2>&1\r\n'
        "timeout /t 1 /nobreak >nul\r\n"
        "set /a n=0\r\n"
        ":retry\r\n"
        f'rd /s /q "{target}" 2>nul\r\n'
        f'if not exist "{target}" goto done\r\n'
        "set /a n+=1\r\n"
        "if %n% geq 20 goto done\r\n"
        "timeout /t 1 /nobreak >nul\r\n"
        "goto retry\r\n"
        ":done\r\n"
        'del /f /q "%~f0" >nul 2>&1\r\n'
    )
    try:
        script.write_text(body, encoding="gbk", errors="replace")
    except OSError as exc:
        _message_box(f"卸载失败：写不了临时脚本（{exc}）")
        return

    DETACHED_PROCESS = 0x00000008
    CREATE_NO_WINDOW = 0x08000000
    subprocess.Popen(
        ["cmd", "/c", str(script)],
        creationflags=DETACHED_PROCESS | CREATE_NO_WINDOW,
        close_fds=True,
    )


class ManagerApp:
    def __init__(self) -> None:
        from .core.config import Config

        self.config = Config()
        self.logs = LogStore(max_lines=int(self.config.get("log.maxLines", 3000)))
        self.logs.cleanup(int(self.config.get("log.keepDays", 14)))
        self.bot = BotProcess(self.config, self.logs)
        self.plugins = PluginHost(self.config, self.logs)
        self.api = Api(self.config, self.logs, self.bot, self.plugins)
        # 界面里的 × / 退出按钮要和托盘「退出」走同一套收尾（停机器人、关托盘、退进程）
        self.api.quit_hook = self.quit_app
        self.window = None
        self.tray = None
        self._quitting = False
        self._resize_timer = None

    # ------------------------------------------------------------------ 窗口
    def _screen_size(self) -> tuple[int, int]:
        """可用工作区尺寸：先问 WinForms 要（扣掉任务栏），拿不到再退回全屏。"""
        try:
            from System.Windows.Forms import Screen  # type: ignore

            area = Screen.PrimaryScreen.WorkingArea
            return int(area.Width), int(area.Height)
        except Exception:
            pass
        try:
            import ctypes

            user32 = ctypes.windll.user32
            return user32.GetSystemMetrics(0), user32.GetSystemMetrics(1)
        except Exception:
            return 1920, 1080

    def build_window(self):
        sw, sh = self._screen_size()
        w = min(int(self.config.get("window.width", 1120)), int(sw * 0.92))
        h = min(int(self.config.get("window.height", 760)), int(sh * 0.88))

        index = Path(web_dir()) / "index.html"
        if not index.exists():
            raise FileNotFoundError(f"界面资源缺失：{index}")

        frameless = bool(self.config.get("window.frameless", True))
        self.window = webview.create_window(
            title=APP_NAME,
            url=str(index),
            js_api=self.api,
            width=w,
            height=h,
            min_size=(980, 640),
            frameless=frameless,
            easy_drag=False,
            background_color="#0b0d0f",
            text_select=True,
        )
        self.api._window = self.window
        self.window.events.closing += self._on_closing
        self.window.events.loaded += self._on_loaded
        self._bind_size_persist()
        return self.window

    def _bind_size_persist(self) -> None:
        """记住用户拖出来的窗口大小；后端没有 resized 事件就安静跳过。"""
        events = getattr(self.window, "events", None)
        handler = getattr(events, "resized", None)
        if handler is None:
            return

        def on_resized(*_args):
            # 拖动过程中事件很密，停手 0.6 秒再落盘，避免反复写配置文件
            if self._resize_timer is not None:
                self._resize_timer.cancel()
            timer = threading.Timer(0.6, self._save_window_size)
            timer.daemon = True
            self._resize_timer = timer
            timer.start()

        try:
            handler += on_resized
        except Exception:
            pass

    def _save_window_size(self) -> None:
        """把当前窗口大小写进配置；跑在定时器线程上，所以不碰 WinForms。"""
        try:
            w, h = int(self.window.width), int(self.window.height)
            sw, sh = self._screen_size()
            # 接近工作区尺寸说明是最大化，不是用户手动拖出来的偏好
            if w >= sw * 0.98 and h >= sh * 0.98:
                return
            if 900 <= w <= 10000 and 600 <= h <= 10000:
                self.config.update({"window": {"width": w, "height": h}})
        except Exception:
            pass

    def _on_loaded(self) -> None:
        self.logs.add(f"{APP_NAME} 界面已就绪", "manager")
        if self.config.get("bot.autoStart") and not self.bot.is_running():
            self.bot.start()

    def _on_closing(self):
        """关窗口：默认收进托盘；设置里选了「退出应用」就真退出。"""
        if self._quitting or not self.tray:
            return True
        if str(self.config.get("window.closeAction", "tray")) == "quit":
            self._quitting = True
            self.logs.add("关闭窗口：按设置直接退出", "manager")
            if self.config.get("bot.stopOnExit", True):
                self.bot.stop()
            try:
                self.tray.stop()
            except Exception:
                pass
            return True
        try:
            self.window.hide()
        except Exception:
            pass
        return False

    def quit_app(self) -> None:
        """唯一退出路径：停机器人（按设置）→ 关托盘 → 销毁窗口。"""
        self.logs.add("正在退出管家…", "manager", "info")
        self._quitting = True
        if self.config.get("bot.stopOnExit", True):
            self.bot.stop()
        try:
            if self.tray:
                self.tray.stop()
        except Exception:
            pass
        try:
            if self.window:
                self.window.destroy()
            else:
                os._exit(0)
        except Exception:
            os._exit(0)

    # ------------------------------------------------------------------ 托盘
    def start_tray(self) -> None:
        try:
            import pystray
        except Exception as exc:
            self.logs.add(f"托盘不可用（pystray 未安装）：{exc}", "manager", "warn")
            return

        image = _make_tray_image()
        if image is None:
            return

        def show(_icon=None, _item=None):
            try:
                self.window.show()
                self.window.restore()
            except Exception:
                pass

        def toggle_bot(_icon=None, _item=None):
            if self.bot.is_running():
                self.bot.stop()
            else:
                self.bot.start()

        def restart(_icon=None, _item=None):
            self.bot.restart()

        def quit_app(_icon=None, _item=None):
            self.quit_app()

        menu = pystray.Menu(
            pystray.MenuItem("显示窗口", show, default=True),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem(lambda _i: "停止机器人" if self.bot.is_running() else "启动机器人", toggle_bot),
            pystray.MenuItem("重启机器人", restart),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("退出", quit_app),
        )
        self.tray = pystray.Icon("fbm", image, APP_NAME, menu)
        threading.Thread(target=self.tray.run, daemon=True).start()
        self.logs.add("托盘图标已启动", "manager")

    # ------------------------------------------------------------------ 运行
    def run(self) -> None:
        self.build_window()
        self.start_tray()
        self.logs.add(f"{APP_NAME} 启动完成", "manager")
        webview.start(
            debug=os.environ.get("FBM_DEBUG") == "1",
            gui="edgechromium",
            # 界面资源随 exe 一起更新，开着缓存会导致升级后还跑旧 JS
            private_mode=True,
            storage_path=str(app_dir() / ".webview"),
        )
        # webview.start 返回 = 窗口关闭
        if self.config.get("bot.stopOnExit", True):
            self.bot.stop()


def main() -> None:
    if "--uninstall" in sys.argv:
        _run_uninstall(ask="--yes" not in sys.argv)
        return
    _ensure_dirs()
    if _already_running():
        _message_box("飞书机器人管家已经在运行了，看右下角托盘图标。")
        return
    try:
        ManagerApp().run()
    except Exception as exc:
        import traceback

        detail = traceback.format_exc()
        try:
            (app_dir() / "crash.log").write_text(detail, encoding="utf-8")
        except Exception:
            pass
        _message_box(f"启动失败：{exc}\n\n详情已写入 crash.log")
        sys.exit(1)


if __name__ == "__main__":
    main()
