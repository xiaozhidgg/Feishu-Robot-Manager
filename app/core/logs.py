"""日志缓冲与落盘。

设计目标：界面里能实时看、能按级别过滤、退出后还能翻。
内存里保留最近 N 条（给前端轮询），同时按天写文件。
"""
from __future__ import annotations

import threading
import time
from collections import deque
from datetime import datetime
from pathlib import Path
from typing import Deque, Dict, List

from .config import app_dir

LEVEL_WORDS = (
    ("[error]", "error"),
    ("[err]", "error"),
    ("错误", "error"),
    ("失败", "error"),
    ("❌", "error"),
    ("[warn]", "warn"),
    ("警告", "warn"),
    ("⚠", "warn"),
)


def guess_level(line: str) -> str:
    low = line.lower()
    for word, level in LEVEL_WORDS:
        if word in low:
            return level
    return "info"


class LogStore:
    def __init__(self, max_lines: int = 3000, log_dir: Path | None = None) -> None:
        self._lock = threading.Lock()
        self._items: Deque[Dict] = deque(maxlen=max_lines)
        self._seq = 0
        self.log_dir = log_dir or (app_dir() / "logs")
        self.log_dir.mkdir(parents=True, exist_ok=True)
        self._fh = None
        self._fh_day = ""

    # ------------------------------------------------------------------ 写入
    def add(
        self,
        text: str,
        source: str = "manager",
        level: str | None = None,
        kind: str | None = None,
        detail: str | None = None,
    ) -> Dict:
        """写一条日志。

        text 是界面那一行、也是落盘的摘要；detail 只留在内存里给折叠块用，
        不写文件 —— 群消息正文不该进保留 14 天的日志文件。
        """
        line = (text or "").rstrip("\r\n")
        if not line.strip():
            return {}
        with self._lock:
            self._seq += 1
            item = {
                "id": self._seq,
                "ts": time.time(),
                "time": datetime.now().strftime("%H:%M:%S"),
                "level": level or guess_level(line),
                "source": source,
                "text": line,
            }
            if kind:
                item["kind"] = kind
            if detail:
                item["detail"] = detail[:8000]
            self._items.append(item)
            # 落盘也放在锁里：机器人输出线程和界面线程会同时进来，
            # 共用同一个文件句柄，乱序或半行都可能发生。
            self._write_file(item)
        return item

    def _write_file(self, item: Dict) -> None:
        try:
            day = datetime.now().strftime("%Y-%m-%d")
            if self._fh is None or day != self._fh_day:
                if self._fh:
                    self._fh.close()
                self._fh = open(self.log_dir / f"manager-{day}.log", "a", encoding="utf-8")
                self._fh_day = day
            stamp = datetime.fromtimestamp(item["ts"]).strftime("%Y-%m-%d %H:%M:%S")
            self._fh.write(f"{stamp} [{item['source']}/{item['level']}] {item['text']}\n")
            self._fh.flush()
        except Exception:
            pass  # 日志写失败不能拖垮主流程

    # ------------------------------------------------------------------ 读取
    def since(self, last_id: int = 0, limit: int = 800) -> List[Dict]:
        with self._lock:
            items = [i for i in self._items if i["id"] > last_id]
        return items[-limit:]

    def tail(self, n: int = 200) -> List[Dict]:
        with self._lock:
            return list(self._items)[-n:]

    def clear(self) -> None:
        with self._lock:
            self._items.clear()

    def export(self, target: Path | None = None) -> str:
        out = target or (app_dir() / f"logs-export-{datetime.now():%Y%m%d-%H%M%S}.txt")
        with self._lock:
            items = list(self._items)
        lines = []
        for i in items:
            stamp = datetime.fromtimestamp(i["ts"]).strftime("%Y-%m-%d %H:%M:%S")
            lines.append(f"{stamp} [{i['source']}/{i['level']}] {i['text']}")
        out.write_text("\n".join(lines) or "(空)", encoding="utf-8")
        return str(out)

    def cleanup(self, keep_days: int = 14) -> None:
        cutoff = time.time() - keep_days * 86400
        for p in self.log_dir.glob("manager-*.log"):
            try:
                if p.stat().st_mtime < cutoff:
                    p.unlink()
            except OSError:
                pass
