"""演示插件：后端 Python 部分。

register(ctx) 返回一个 {方法名: 函数}，前端通过
  pywebview.api.plugin_call("quickcheck", "info")
调到这里。ctx 里有 log / config 两个能力。
"""
import os
import platform
import shutil
import subprocess


def register(ctx):
    def info(payload=None):
        node = ctx["config"].get("bot.node") or "node"
        node_path = shutil.which(node) or node
        node_ver = "未检测到"
        try:
            out = subprocess.run(
                [node_path, "-v"], capture_output=True, text=True, timeout=6
            )
            node_ver = (out.stdout or out.stderr).strip() or "未知"
        except Exception as exc:
            node_ver = f"调用失败：{exc}"

        ctx["log"]("执行了一次环境检测")

        return {
            "系统": f"{platform.system()} {platform.release()}",
            "Python": platform.python_version(),
            "Node 版本": node_ver,
            "Node 路径": node_path,
            "机器人目录": str(ctx["config"].get("bot.dir") or "(未设置)"),
            "目录存在": os.path.isdir(str(ctx["config"].get("bot.dir") or "")),
            "工作目录": os.getcwd(),
        }

    return {"info": info}
