"""NAS 同步插件：把本机的 docs.json 传到 NAS 上机器人挂载的目录。

设计要点：
- 只依赖标准库；写 UNC 路径（\\\\host\\share\\...）用 Windows 的 SMB 客户端，不需要映射盘符。
- 先写临时文件再替换：避免容器正在读时读到半个文件。
- 写完立刻回读并 json.loads 校验，条数对不上就报错。
- 重启容器交给可配置的命令（例如 ssh root@192.168.1.2 "docker restart feishu-bot"），
  没配置就只上传，由用户在 UGOS 里点重启。
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
from pathlib import Path

DEFAULT_DIR = r"\\jiuyeyunpan\docker\FeishuBot\data"
FILE_NAME = "docs.json"
SETTINGS_KEY = "nasSync"
RESTART_TIMEOUT = 30


# ---------------------------------------------------------------- 配置

def _settings(config) -> dict:
    cur = config.get(SETTINGS_KEY) or {}
    if not isinstance(cur, dict):
        cur = {}
    return {
        "dir": str(cur.get("dir") or DEFAULT_DIR).strip() or DEFAULT_DIR,
        "restart": str(cur.get("restart") or "").strip(),
        "autoRestart": bool(cur.get("autoRestart", False)),
    }


def _local_source(config) -> Path | None:
    """本机要上传的那份 docs.json：优先机器人目录，其次安装目录下的 bot/。"""
    cands: list[Path] = []
    bot = str(config.get("bot.dir") or "").strip()
    if bot:
        cands.append(Path(bot) / FILE_NAME)
    here = Path(__file__).resolve().parents[2]  # app_dir()
    cands.extend([here / "bot" / FILE_NAME, here / FILE_NAME])
    for p in cands:
        if p.is_file():
            return p
    return None


# ---------------------------------------------------------------- 读写

def _read_json(path: Path) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, dict):
        raise ValueError("根节点不是对象")
    return data


def _names_of(data: dict) -> list[str]:
    out = []
    for d in data.get("docs") or []:
        if isinstance(d, dict):
            out.append(str(d.get("name") or d.get("url") or "?"))
    return out


def _describe(path: Path) -> dict:
    if not path.is_file():
        return {"exists": False, "path": str(path), "size": 0, "mtime": "",
                "count": 0, "names": [], "error": None}
    st = path.stat()
    info = {
        "exists": True,
        "path": str(path),
        "size": st.st_size,
        "mtime": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(st.st_mtime)),
        "count": 0,
        "names": [],
        "error": None,
    }
    try:
        data = _read_json(path)
        info["names"] = _names_of(data)
        info["count"] = len(info["names"])
    except Exception as exc:  # 文件在但内容坏了
        info["error"] = f"{type(exc).__name__}: {exc}"
    return info


def _atomic_write(target: Path, payload: str) -> None:
    """先写 .tmp 再替换；SMB 上 os.replace 偶尔失败，回退成备份+改名。"""
    tmp = target.with_name(target.name + ".tmp")
    tmp.write_text(payload, encoding="utf-8", newline="\n")
    try:
        os.replace(str(tmp), str(target))
        return
    except OSError:
        pass
    if target.exists():
        shutil.copy2(str(target), str(target.with_name(target.name + ".bak")))
    shutil.move(str(tmp), str(target))


# ---------------------------------------------------------------- 动作

def _status(config) -> dict:
    s = _settings(config)
    target = Path(s["dir"]) / FILE_NAME
    src = _local_source(config)
    local = _describe(src) if src else {"exists": False, "path": "", "count": 0, "names": []}
    remote = _describe(target)
    same = (
        local.get("exists") and remote.get("exists")
        and local.get("count") == remote.get("count")
        and local.get("names") == remote.get("names")
    )
    return {
        "ok": True,
        "settings": s,
        "local": local,
        "remote": remote,
        "same": bool(same),
        "dir_exists": Path(s["dir"]).is_dir(),
    }


def _upload(config, log) -> dict:
    s = _settings(config)
    src = _local_source(config)
    if not src:
        return {"ok": False, "error": "本机没找到 docs.json（先设置好机器人目录，或把 docs.json 放进安装目录）"}

    target_dir = Path(s["dir"])
    if not target_dir.is_dir():
        return {"ok": False, "error": f"NAS 目录打不开：{target_dir}（先确认共享已连上、路径没写错）"}

    try:
        data = _read_json(src)          # 上传前先校验，坏文件不上传
        names = _names_of(data)
        payload = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
    except Exception as exc:
        return {"ok": False, "error": f"本机这份 {src} 不是合法 JSON：{exc}"}

    target = target_dir / FILE_NAME
    try:
        _atomic_write(target, payload)
    except Exception as exc:
        return {"ok": False, "error": f"写入失败：{type(exc).__name__}: {exc}"}

    remote = _describe(target)
    if remote.get("error") or remote.get("count") != len(names):
        return {"ok": False, "error": f"写进去了但回读不对：{remote.get('error') or '条数不一致'}", "remote": remote}

    log(f"NAS 同步：已上传 {len(names)} 条文档清单 → {target}", "info")
    return {"ok": True, "uploaded": len(names), "source": str(src), "target": str(target), "remote": remote}


def _restart(config, log) -> dict:
    cmd = _settings(config)["restart"]
    if not cmd:
        return {"ok": False, "error": "没有配置重启命令（可在页签里填 ssh 命令，或去 UGOS 手动重启）"}
    try:
        proc = subprocess.run(
            cmd, shell=True, capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=RESTART_TIMEOUT,
        )
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": f"命令超过 {RESTART_TIMEOUT}s 没结束"}
    except Exception as exc:
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}

    out = "\n".join(
        line for line in ((proc.stdout or "") + (proc.stderr or "")).splitlines()
        if "Permanently added" not in line
    ).strip()
    ok = proc.returncode == 0
    log(f"NAS 同步：重启容器 {'成功' if ok else '失败'}（{proc.returncode}）", "info" if ok else "error")
    return {"ok": ok, "code": proc.returncode, "output": out[-1500:]}


def register(ctx):
    """插件入口：返回 {方法名: 可调用对象}。payload 作为唯一参数传入（可为 None）。"""
    config, log = ctx["config"], ctx["log"]

    def status(payload=None):
        return _status(config)

    def save(payload=None):
        patch = payload or {}
        cur = _settings(config)
        nxt = {
            "dir": str(patch.get("dir", cur["dir"])).strip() or DEFAULT_DIR,
            "restart": str(patch.get("restart", cur["restart"])).strip(),
            "autoRestart": bool(patch.get("autoRestart", cur["autoRestart"])),
        }
        config.set(SETTINGS_KEY, nxt)
        log(f"NAS 同步：设置已保存（{nxt['dir']}）", "info")
        return {"ok": True, "settings": nxt}

    def upload(payload=None):
        res = _upload(config, log)
        if res.get("ok") and _settings(config)["autoRestart"] and _settings(config)["restart"]:
            res["restart"] = _restart(config, log)
        elif res.get("ok"):
            res["hint"] = "已上传。别忘了重启机器人（UGOS → Docker → 重启容器），或在这里配置重启命令。"
        return res

    def restart(payload=None):
        return _restart(config, log)

    return {"status": status, "save": save, "upload": upload, "restart": restart}
