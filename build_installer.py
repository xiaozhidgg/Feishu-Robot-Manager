"""打包安装程序：python build_installer.py

产出：<项目根>\飞书机器人管家-安装包.exe，并复制一份到「飞书机器人」目录。

打程序本体（exe + README + 示例插件 + 一份机器人副本），**不包含**任何本地配置：
manager.config.json / logs / .webview / 机器人的 .env、docs.json 都不会进包。
"""
from __future__ import annotations

import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
STAGE = ROOT / "build" / "payload"
DIST = ROOT / "build" / "installer-dist"
SETUP_NAME = "飞书机器人管家-安装包"
ICON = ROOT / "build" / "icon.ico"
DELIVER_DIR = ROOT.parent  # D:\...\飞书机器人


def stage_payload() -> Path:
    """挑出要装进包里的东西。这里就是"不要把什么打进去"的唯一开关。"""
    if STAGE.exists():
        shutil.rmtree(STAGE)
    STAGE.mkdir(parents=True)

    exe = ROOT / "FeishuBotManager.exe"
    if not exe.exists():
        raise SystemExit("先跑 build.py 生成 FeishuBotManager.exe")

    shutil.copy2(exe, STAGE / "FeishuBotManager.exe")

    for name in ("README.md",):
        src = ROOT / name
        if src.exists():
            shutil.copy2(src, STAGE / name)

    # 示例插件（纯代码，不含用户数据）
    plugins_src = ROOT / "plugins"
    if plugins_src.exists():
        shutil.copytree(
            plugins_src,
            STAGE / "plugins",
            ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "*.log"),
        )

    # 机器人本体（可选）：带上它，装完就有个能直接跑的 <安装目录>\bot
    bot_src = ROOT.parent / "feishu-deepseek-bot"
    if (bot_src / "index.js").exists():
        shutil.copytree(
            bot_src,
            STAGE / "bot",
            ignore=shutil.ignore_patterns(
                ".env", "*.log", ".git", "docs.json", ".cache", "__pycache__", "*.pyc"
            ),
        )
    else:
        print("[安装包] 没找到 feishu-deepseek-bot，这一版不带内置机器人")

    # 明确不带：manager.config.json / logs / .webview / .env
    # 也不再带 卸载.exe：卸载交给主程序的 --uninstall，省掉一整个 Python 运行时
    return STAGE


def main() -> int:
    stage_payload()
    items = sorted(p.name for p in STAGE.iterdir())
    print(f"[安装包] 负载内容：{items}")

    args = [
        sys.executable,
        "-m",
        "PyInstaller",
        "--noconfirm",
        "--clean",
        "--onefile",
        "--windowed",
        "--name",
        SETUP_NAME,
        "--add-data",
        f"{STAGE};payload",
        "--add-data",
        f"{ROOT / 'installer' / 'web'};web",
        "--paths",
        str(ROOT / "installer"),
        "--hidden-import",
        "core",
        "--distpath",
        str(DIST),
        "--exclude-module",
        "tkinter",
        "--exclude-module",
        "numpy",
        "--exclude-module",
        "pytest",
        "--exclude-module",
        "pystray",
        "--exclude-module",
        "PIL",
    ]
    if ICON.exists():
        args += ["--icon", str(ICON)]
    args.append(str(ROOT / "installer" / "main.py"))

    print("[安装包] 开始打包…")
    started = time.time()
    if subprocess.run(args, cwd=str(ROOT)).returncode != 0:
        print("[安装包] 打包失败")
        return 1

    built = DIST / f"{SETUP_NAME}.exe"
    if not built.exists():
        print("[安装包] 没找到产物")
        return 1

    final = DELIVER_DIR / f"{SETUP_NAME}.exe"
    try:
        if final.exists():
            final.unlink()
        shutil.move(str(built), str(final))
    except PermissionError:
        print(f"[安装包] {final} 被占用，先关掉它再打包")
        return 1

    size = final.stat().st_size / 1048576
    print(f"[安装包] 完成：{final}  ({size:.1f} MB)  用时 {time.time() - started:.0f}s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
