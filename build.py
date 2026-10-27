"""打包脚本：python build.py [--console] [--onedir]

产物：dist/FeishuBotManager.exe（单文件，界面+插件宿主都在里面）
"""
from __future__ import annotations

import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DIST = ROOT / "dist"
BUILD = ROOT / "build"
ICON = BUILD / "icon.ico"


def make_icon() -> Path | None:
    """顺手画个图标，避免依赖外部素材。"""
    try:
        from PIL import Image, ImageDraw
    except Exception:
        return None
    BUILD.mkdir(parents=True, exist_ok=True)
    size = 256
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([8, 8, size - 9, size - 9], radius=62, fill=(10, 143, 71, 255))
    d.rounded_rectangle([56, 74, 200, 158], radius=30, fill=(255, 255, 255, 235))
    d.polygon([(88, 158), (88, 200), (134, 158)], fill=(255, 255, 255, 235))
    img.save(ICON, sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    return ICON


def check_web_js() -> bool:
    """打包前先查前端语法。

    app.js 里一个笔误（比如在非 async 回调里 await）会让整个脚本不执行，
    界面就永远停在「正在连接后端…」的遮罩上——PyInstaller 不会管这种事。
    """
    node = shutil.which("node")
    if not node:
        print("[构建] 没找到 node，跳过前端语法检查")
        return True
    web_js = ROOT / "app" / "web" / "js"
    for js in sorted(web_js.glob("*.js")):
        result = subprocess.run([node, "--check", str(js)], capture_output=True, text=True)
        if result.returncode != 0:
            print(f"[构建] {js.name} 语法错误：")
            print(result.stderr.strip())
            return False
        print(f"[构建] 前端语法检查通过：{js.name}")
    return True


def main() -> int:
    console = "--console" in sys.argv
    if not check_web_js():
        return 1
    onedir = "--onedir" in sys.argv

    icon = make_icon()
    args = [
        sys.executable,
        "-m",
        "PyInstaller",
        "--noconfirm",
        "--clean",
        "--onedir" if onedir else "--onefile",
        "--console" if console else "--windowed",
        "--name",
        "FeishuBotManager",
        "--add-data",
        f"{ROOT / 'app' / 'web'};web",
        "--collect-all",
        "webview",
        "--hidden-import",
        "pystray._win32",
        "--hidden-import",
        "PIL._imaging",
        "--hidden-import",
        "clr_loader",
        "--exclude-module",
        "tkinter",
        "--exclude-module",
        "numpy",
        "--exclude-module",
        "pytest",
        # 管家只画托盘图标，从不打开图片、也不画文字：AVIF 解码器和 FreeType
        # 各占 4.3MB / 1.0MB，排掉不影响任何功能（ssl 不能排，pywebview 启动就用）。
        "--exclude-module",
        "PIL._avif",
        "--exclude-module",
        "PIL._imagingft",
    ]
    if icon and icon.exists():
        args += ["--icon", str(icon)]
    args.append(str(ROOT / "run.py"))

    print("[打包] 开始，预计 1-3 分钟…")
    started = time.time()
    proc = subprocess.run(args, cwd=str(ROOT))
    if proc.returncode != 0:
        print("[打包] 失败，看上面 PyInstaller 的输出")
        return proc.returncode

    exe = DIST / ("FeishuBotManager.exe" if not onedir else "FeishuBotManager/FeishuBotManager.exe")
    if not exe.exists():
        print("[打包] 没找到产物，检查 dist 目录")
        return 1

    # 把产物挪到项目根目录，双击就能开，不用钻进 dist
    final = ROOT / exe.name
    try:
        if final.exists():
            final.unlink()
        shutil.move(str(exe), str(final))
    except PermissionError:
        print(f"[打包] {final.name} 正在运行，先关掉管家再打包")
        return 1

    size = final.stat().st_size / 1048576
    print(f"[打包] 完成：{final}  ({size:.1f} MB)  用时 {time.time() - started:.0f}s")

    # dist 只剩空壳，清掉免得混淆
    try:
        shutil.rmtree(DIST, ignore_errors=True)
    except Exception:
        pass

    # 插件目录在根目录已经有一份源码，不再复制
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
