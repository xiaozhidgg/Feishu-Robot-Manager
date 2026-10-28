"""机器人进程管理：启动 / 停止 / 重启 / 状态。

只管一件事：把 `node index.js` 拉起来，把它的输出接进日志，
然后确保停得干净（Windows 下连子进程一起收掉）。
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import threading
import time
from pathlib import Path
from typing import Any, Dict, Optional

from .logs import LogStore

CREATE_NO_WINDOW = 0x08000000

# 机器人往 stdout 打的「结构化消息」前缀；界面据此渲染成可折叠的问答日志
MSG_PREFIX = "\x1eFBM "


class BotProcess:
    def __init__(self, config, logs: LogStore) -> None:
        self.config = config
        self.logs = logs
        self._proc: Optional[subprocess.Popen] = None
        self._reader: Optional[threading.Thread] = None
        self._lock = threading.RLock()
        self._started_at: float = 0.0
        self._stopping = False
        self._last_exit: Optional[int] = None
        self._on_change = None

    # ------------------------------------------------------------------ 工具
    def set_change_callback(self, cb) -> None:
        self._on_change = cb

    def _notify(self) -> None:
        if self._on_change:
            try:
                self._on_change(self.status())
            except Exception:
                pass

    @property
    def bot_raw(self) -> str:
        """配置里原样的机器人目录，空串表示还没设置。"""
        return (self.config.get("bot.dir") or "").strip()

    @property
    def bot_dir(self) -> Optional[Path]:
        """已设置的机器人目录；没设置时返回 None。

        不能返回 ``Path("")``——它在 Windows 上等于当前工作目录 ``.``，
        会让界面把「还没配置」显示成一个莫名奇妙的点，还会拿安装目录去
        找 index.js。
        """
        raw = self.bot_raw
        return Path(raw) if raw else None

    def resolve_node(self) -> str:
        node = (self.config.get("bot.node") or "node").strip()
        if os.path.isabs(node) and Path(node).exists():
            return node
        found = shutil.which(node)
        return found or node

    # ------------------------------------------------------------------ 检查
    def preflight(self) -> Dict[str, Any]:
        """启动前体检，返回问题清单给界面提示。"""
        issues = []
        bot_dir = self.bot_dir
        if bot_dir is None:
            issues.append({
                "level": "error",
                "text": "还没设置机器人目录：在「设置 → 机器人目录」里选一下 feishu-deepseek-bot 文件夹",
            })
        elif not bot_dir.exists():
            issues.append({"level": "error", "text": f"机器人目录不存在：{bot_dir}"})
        else:
            if not (bot_dir / "index.js").exists():
                issues.append({"level": "error", "text": f"{bot_dir} 下没有 index.js"})
            if not (bot_dir / ".env").exists():
                issues.append({"level": "warn", "text": "没有 .env，机器人启动后会因为缺凭证报错"})
            if not (bot_dir / "node_modules").exists():
                issues.append({"level": "warn", "text": "没装依赖，先在该目录执行 npm install"})

        node = self.resolve_node()
        if not (os.path.isabs(node) and Path(node).exists()) and not shutil.which(node):
            issues.append({"level": "error", "text": f"找不到 Node（当前配置：{node}）"})
        return {"ok": not any(i["level"] == "error" for i in issues), "issues": issues, "node": node}

    # ------------------------------------------------------------------ 控制
    def start(self) -> Dict[str, Any]:
        with self._lock:
            if self.is_running():
                return {"ok": False, "message": "机器人已经在运行了"}

            check = self.preflight()
            if not check["ok"]:
                msg = "；".join(i["text"] for i in check["issues"] if i["level"] == "error")
                self.logs.add(f"启动被拦下：{msg}", "manager", "error")
                return {"ok": False, "message": msg}

            for issue in check["issues"]:
                self.logs.add(issue["text"], "manager", issue["level"])

            bot_dir = self.bot_dir
            if bot_dir is None:
                return {"ok": False, "message": "还没设置机器人目录，去「设置」里选一下"}

            env = os.environ.copy()
            env.setdefault("PYTHONIOENCODING", "utf-8")
            env["FORCE_COLOR"] = "0"
            env["FBM_MANAGED"] = "1"  # 让机器人知道输出被管家接走了，可以打结构化消息

            try:
                self._proc = subprocess.Popen(
                    [check["node"], "index.js"],
                    cwd=str(bot_dir),
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    stdin=subprocess.DEVNULL,
                    env=env,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    bufsize=1,
                    creationflags=CREATE_NO_WINDOW,
                )
            except Exception as exc:
                self.logs.add(f"启动失败：{exc}", "manager", "error")
                return {"ok": False, "message": str(exc)}

            self._started_at = time.time()
            self._stopping = False
            self._last_exit = None
            self.logs.add(f"已启动机器人（pid {self._proc.pid}）", "manager", "info")

            self._reader = threading.Thread(target=self._pump, args=(self._proc,), daemon=True)
            self._reader.start()
            self._notify()
            return {"ok": True, "pid": self._proc.pid}

    def _pump(self, proc: subprocess.Popen) -> None:
        """把子进程输出逐行送进日志，顺带盯着它什么时候退出。"""
        try:
            assert proc.stdout is not None
            for line in proc.stdout:
                if self._emit_message(line):
                    continue
                self.logs.add(line, "bot")
        except Exception as exc:
            self.logs.add(f"读取输出出错：{exc}", "manager", "warn")
        finally:
            code = proc.wait()
            with self._lock:
                if self._proc is proc:
                    self._last_exit = code
                    self._proc = None
                    self._started_at = 0.0
            if self._stopping:
                self.logs.add(f"机器人已停止（退出码 {code}）", "manager", "info")
            else:
                level = "info" if code == 0 else "error"
                self.logs.add(f"机器人进程结束（退出码 {code}）", "manager", level)
            self._notify()

    def _emit_message(self, line: str) -> bool:
        """识别机器人打的 `\x1eFBM {json}` 结构化消息，转成一条问答日志。

        返回 True 表示这行已经被消费，不再当普通输出处理。
        """
        # 注意：不能用 lstrip() ——  在 Python 眼里也算空白，会把前缀吃掉
        raw = (line or "").lstrip(" 	")
        if not raw.startswith(MSG_PREFIX):
            return False
        try:
            payload = json.loads(raw[len(MSG_PREFIX):])
        except (ValueError, TypeError):
            return False
        if not isinstance(payload, dict):
            return False

        kind = payload.get("kind")
        text = str(payload.get("text") or "")
        compact = " ".join(text.split())

        if kind == "ask":
            head = compact[:60] + ("…" if len(compact) > 60 else "")
            self.logs.add(f"🙋 提问：{head}", "bot", "info", kind="ask", detail=text)
        elif kind == "think":
            model = payload.get("model") or ""
            self.logs.add(f"🤔 思考中{('（' + model + '）') if model else ''}", "bot", "info", kind="think")
        elif kind == "reply":
            self.logs.add(f"💬 回复（{len(text)} 字）", "bot", "info", kind="reply", detail=text)
        else:
            return False
        return True

    def stop(self, timeout: float = 6.0) -> Dict[str, Any]:
        with self._lock:
            proc = self._proc
            if not proc or proc.poll() is not None:
                self._proc = None
                return {"ok": False, "message": "机器人没在运行"}

            self._stopping = True
            self.logs.add("正在停止机器人…", "manager", "info")
            pid = proc.pid

        try:
            if os.name == "nt":
                # 连子进程一起收，否则 node 的孙进程会残留在后台
                subprocess.run(
                    ["taskkill", "/PID", str(pid), "/T", "/F"],
                    capture_output=True,
                    creationflags=CREATE_NO_WINDOW,
                )
            else:
                proc.terminate()
            proc.wait(timeout=timeout)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass

        with self._lock:
            self._proc = None
            self._started_at = 0.0
        self._notify()
        return {"ok": True}

    def restart(self) -> Dict[str, Any]:
        if self.is_running():
            self.stop()
            time.sleep(0.4)
        return self.start()

    # ------------------------------------------------------------------ 状态
    def is_running(self) -> bool:
        proc = self._proc
        return bool(proc and proc.poll() is None)

    def status(self) -> Dict[str, Any]:
        running = self.is_running()
        return {
            "running": running,
            "pid": self._proc.pid if running and self._proc else None,
            "uptime": int(time.time() - self._started_at) if running and self._started_at else 0,
            "lastExit": self._last_exit,
            "botDir": self.bot_raw,
            "node": self.resolve_node(),
        }
