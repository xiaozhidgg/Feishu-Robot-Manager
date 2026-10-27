"""`.env` 读写：保留注释、顺序和空行，只改值。"""
from __future__ import annotations

import re
from typing import Dict, Tuple

LINE_RE = re.compile(r"^(?P<lead>\s*)(?P<key>[A-Za-z_][A-Za-z0-9_]*)(?P<eq>\s*=\s*)(?P<value>.*)$")

# 界面上当成密码框处理的键
SECRET_KEYS = {"FEISHU_APP_SECRET", "DEEPSEEK_API_KEY"}


def parse(text: str) -> Dict[str, str]:
    out: Dict[str, str] = {}
    for line in (text or "").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        m = LINE_RE.match(line)
        if not m:
            continue
        out[m.group("key")] = _unwrap(m.group("value"))
    return out


def _unwrap(value: str) -> str:
    v = (value or "").strip()
    if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
        return v[1:-1]
    return v


def _wrap(value: str) -> str:
    v = str(value or "").replace("\r", " ").replace("\n", " ")
    if v == "":
        return ""
    if re.search(r"[\s#\"']", v):
        return '"' + v.replace('"', '\\"') + '"'
    return v


def merge(text: str, patch: Dict[str, str]) -> str:
    """把 patch 里的键写回文本；新键追加到末尾。"""
    remaining = dict(patch)
    lines = (text or "").splitlines()

    for idx, line in enumerate(lines):
        m = LINE_RE.match(line)
        if not m:
            continue
        key = m.group("key")
        if key in remaining:
            lines[idx] = f"{m.group('lead')}{key}{m.group('eq')}{_wrap(remaining.pop(key))}"

    if remaining:
        if lines and lines[-1].strip():
            lines.append("")
        for key, value in remaining.items():
            lines.append(f"{key}={_wrap(value)}")
    return "\n".join(lines) + "\n"
