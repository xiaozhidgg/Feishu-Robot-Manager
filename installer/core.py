"""安装核心逻辑：拷贝、快捷方式、卸载项。

GUI 和静默模式共用这一份，避免两边行为不一致。
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Callable, Optional

APP_NAME = "飞书机器人管家"
APP_ID = "FeishuBotManager"
APP_VERSION = "1.0.0"
PUBLISHER = "九叶化妆品"
CREATE_NO_WINDOW = 0x08000000

Progress = Optional[Callable[[int, str], None]]


UNINSTALL_KEY = r"Software\Microsoft\Windows\CurrentVersion\Uninstall\FeishuBotManager"


def detect_install() -> dict:
    """这台机器上装过没有？装了在哪、什么版本。

    先查卸载注册项，再退回默认目录与常见的 Programs 目录；只认「目录里有主程序」的。
    """
    info = {"found": False, "path": "", "version": "", "source": ""}
    try:
        import winreg

        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, UNINSTALL_KEY) as k:
            def read(name: str) -> str:
                try:
                    return str(winreg.QueryValueEx(k, name)[0])
                except OSError:
                    return ""

            loc = read("InstallLocation")
            ver = read("DisplayVersion")
        if loc and (Path(loc) / f"{APP_ID}.exe").exists():
            info.update(found=True, path=loc, version=ver, source="registry")
            return info
    except Exception:
        pass

    for cand in (default_dir(), Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / APP_ID):
        if (cand / f"{APP_ID}.exe").exists():
            info.update(found=True, path=str(cand), version="", source="dir")
            break
    return info


def is_running() -> bool:
    """管家是否正在跑（在跑就写不进安装目录）。"""
    try:
        out = subprocess.run(
            ["tasklist", "/FI", f"IMAGENAME eq {APP_ID}.exe", "/NH"],
            capture_output=True,
            text=True,
            timeout=8,
            creationflags=CREATE_NO_WINDOW,
        )
        return f"{APP_ID}.exe" in (out.stdout or "")
    except Exception:
        return False


# ------------------------------------------------------------------ 路径
def payload_dir() -> Path:
    base = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent.parent))
    return base / "payload"


def web_dir() -> Path:
    base = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))
    return base / "web"


def default_dir() -> Path:
    base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
    return Path(base) / "Programs" / APP_ID


def resolve_target(raw: str | Path) -> Path:
    """把用户选中的「父目录」补成真正的安装目录。

    选中 ``D:\\software`` 会落到 ``D:\\software\\FeishuBotManager``；
    如果目录名本身已经是 ``FeishuBotManager`` / ``飞书机器人管家``，则原样使用，
    避免出现 ``...\\FeishuBotManager\\FeishuBotManager``。
    """
    text = str(raw).strip()
    if not text:
        return default_dir()
    path = Path(text).expanduser()
    name = path.name.lower()
    if name in (APP_ID.lower(), APP_NAME.lower()):
        return path
    return path / APP_ID


def payload_size() -> int:
    root = payload_dir()
    if not root.exists():
        return 0
    total = 0
    for p in root.rglob("*"):
        if p.is_file():
            total += p.stat().st_size
    return total


def dir_status(target: Path) -> dict:
    """给界面判断用：能不能写、装没装过、空间够不够。"""
    info = {
        "exists": False,
        "installed": False,
        "writable": True,
        "freeMB": 0,
        "needMB": 0,
        "error": "",
    }
    info["needMB"] = round(payload_size() / 1048576, 1)
    try:
        info["installed"] = (target / f"{APP_ID}.exe").exists()
        info["exists"] = target.exists()
    except OSError:
        pass

    probe = target
    while not probe.exists() and probe.parent != probe:
        probe = probe.parent
    try:
        info["freeMB"] = round(shutil.disk_usage(probe).free / 1048576)
    except Exception:
        info["freeMB"] = -1

    if info["freeMB"] >= 0 and info["freeMB"] < info["needMB"] + 50:
        info["writable"] = False
        info["error"] = "磁盘剩余空间不够"
    return info


# ------------------------------------------------------------------ 快捷方式
def make_shortcut(
    lnk: Path,
    target: Path,
    workdir: Path,
    icon: Optional[Path] = None,
    arguments: str = "",
) -> bool:
    """用 PowerShell 建 .lnk。ps1 必须带 BOM，否则 PS5.1 读中文路径会乱码。"""
    icon_path = icon or target
    script = f"""$ErrorActionPreference = 'Stop'
$shell = New-Object -ComObject WScript.Shell
$s = $shell.CreateShortcut("{lnk}")
$s.TargetPath = "{target}"
$s.Arguments = "{arguments}"
$s.WorkingDirectory = "{workdir}"
$s.IconLocation = "{icon_path},0"
$s.Description = "{APP_NAME}"
$s.Save()
"""
    tmp = Path(tempfile.gettempdir()) / "fbm-mkshortcut.ps1"
    tmp.write_text("\ufeff" + script, encoding="utf-8")
    try:
        r = subprocess.run(
            ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(tmp)],
            capture_output=True,
            creationflags=CREATE_NO_WINDOW,
            text=True,
        )
        return r.returncode == 0
    except Exception:
        return False
    finally:
        tmp.unlink(missing_ok=True)


def _known_shell_dir(value_name: str, fallback: Path) -> Path:
    """读注册表里的真实「桌面 / 开始菜单」位置。

    桌面可能被重定向到 D:/Desktop、或挪进 OneDrive，直接拼 %USERPROFILE%/Desktop
    会写进一个资源管理器根本不显示的老目录。
    """
    try:
        import winreg

        with winreg.OpenKey(
            winreg.HKEY_CURRENT_USER,
            r"Software\Microsoft\Windows\CurrentVersion\Explorer\Shell Folders",
        ) as k:
            raw, _ = winreg.QueryValueEx(k, value_name)
        path = Path(os.path.expandvars(str(raw)))
        if path.is_dir():
            return path
    except Exception:
        pass
    return fallback


def desktop_dir() -> Path:
    return _known_shell_dir("Desktop", Path(os.environ.get("USERPROFILE", "")) / "Desktop")


def desktop_lnk() -> Path:
    return desktop_dir() / f"{APP_NAME}.lnk"


def startmenu_dir() -> Path:
    return Path(os.environ["APPDATA"]) / "Microsoft" / "Windows" / "Start Menu" / "Programs"


# ------------------------------------------------------------------ 卸载入口
# 不再随包塞一个独立卸载器（那是第二个 Python 单文件，白占 8MB）：
# 卸载由主程序 `--uninstall` 完成，注册表与「卸载」快捷方式都指向主程序。
LEGACY_UNINSTALL_EXE = "卸载.exe"
UNINSTALL_BAT = "卸载.bat"


def uninstall_args() -> str:
    return "--uninstall"


def write_registry(target: Path) -> None:
    import winreg

    exe = target / f"{APP_ID}.exe"
    key_path = rf"Software\Microsoft\Windows\CurrentVersion\Uninstall\{APP_ID}"
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, key_path) as k:
        winreg.SetValueEx(k, "DisplayName", 0, winreg.REG_SZ, APP_NAME)
        winreg.SetValueEx(k, "DisplayVersion", 0, winreg.REG_SZ, APP_VERSION)
        winreg.SetValueEx(k, "Publisher", 0, winreg.REG_SZ, PUBLISHER)
        winreg.SetValueEx(k, "InstallLocation", 0, winreg.REG_SZ, str(target))
        winreg.SetValueEx(k, "DisplayIcon", 0, winreg.REG_SZ, f"{exe},0")
        winreg.SetValueEx(k, "UninstallString", 0, winreg.REG_SZ, f'"{exe}" {uninstall_args()}')
        winreg.SetValueEx(k, "QuietUninstallString", 0, winreg.REG_SZ, f'"{exe}" {uninstall_args()} --yes')
        winreg.SetValueEx(k, "NoModify", 0, winreg.REG_DWORD, 1)
        winreg.SetValueEx(k, "NoRepair", 0, winreg.REG_DWORD, 1)


# ------------------------------------------------------------------ 安装
def write_uninstall_bat(target: Path) -> Path:
    """在安装目录写一个双击即卸载的入口。

    用 .bat 而不是 .lnk，是为了让整个文件夹可以整体拷走也不失效；
    正文只用 ASCII，避免不同系统代码页把中文打成乱码。
    """
    path = target / UNINSTALL_BAT
    crlf = chr(13) + chr(10)
    lines = [
        "@echo off",
        "rem FeishuBotManager uninstaller",
        'start "" "' + chr(37) + '~dp0' + APP_ID + '.exe" --uninstall',
    ]
    path.write_text(crlf.join(lines) + crlf, encoding="ascii", newline="")
    return path


def install(
    target: Path,
    desktop: bool = True,
    start_menu: bool = True,
    registry: bool = True,
    progress: Progress = None,
) -> Path:
    """执行安装。抛异常表示失败，调用方负责提示。"""
    say = progress or (lambda pct, text: None)

    payload = payload_dir()
    exe_src = payload / f"{APP_ID}.exe"
    if not exe_src.exists():
        raise RuntimeError(f"安装包不完整，缺少 {APP_ID}.exe")

    try:
        say(4, "准备安装目录…")
        target.mkdir(parents=True, exist_ok=True)
        time.sleep(0.05)

        say(18, "复制主程序…")
        exe_dst = target / f"{APP_ID}.exe"
        shutil.copy2(exe_src, exe_dst)

        say(52, "复制插件…")
        plugins_src = payload / "plugins"
        plugins_dst = target / "plugins"
        # 已存在就不覆盖，别把用户自己加的插件冲掉
        if plugins_src.exists() and not plugins_dst.exists():
            shutil.copytree(plugins_src, plugins_dst)

        say(62, "复制说明文档…")
        for name in ("README.md",):
            src = payload / name
            if src.exists():
                shutil.copy2(src, target / name)

        say(66, "复制机器人…")
        bot_src = payload / "bot"
        bot_dst = target / "bot"
        # 已存在就原样保留：用户可能在里面改过 index.js、填过 .env
        if bot_src.exists() and not bot_dst.exists():
            shutil.copytree(bot_src, bot_dst)

        say(70, "写卸载入口…")
        write_uninstall_bat(target)

        say(72, "清理旧的卸载器…")
        legacy = target / LEGACY_UNINSTALL_EXE
        try:
            if legacy.exists():
                legacy.unlink()
        except OSError:
            pass

        if registry:
            say(78, "写入卸载信息…")
            write_registry(target)

        say(84, "创建快捷方式…")
        if desktop:
            make_shortcut(desktop_lnk(), exe_dst, target, exe_dst)
        if start_menu:
            menu = startmenu_dir()
            if menu.exists():
                make_shortcut(menu / f"{APP_NAME}.lnk", exe_dst, target, exe_dst)
                # 开始菜单里再放一个「卸载」，跟商业安装包的习惯一致
                make_shortcut(
                    menu / f"卸载 {APP_NAME}.lnk",
                    exe_dst,
                    target,
                    exe_dst,
                    arguments=uninstall_args(),
                )

        say(100, "完成")
        return target
    except PermissionError as exc:
        raise RuntimeError(
            f"没有写入权限：{exc}\n\n如果管家正在运行，请先从托盘退出再安装。"
        ) from exc


def launch(target: Path) -> None:
    exe = target / f"{APP_ID}.exe"
    subprocess.Popen([str(exe)], cwd=str(target))
