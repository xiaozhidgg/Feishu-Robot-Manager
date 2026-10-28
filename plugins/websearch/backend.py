"""联网搜索插件：给机器人开 DeepSeek 官方 Search / Fetch API。

机器人侧（search.js）读 `.env` 里的这三个键决定行为：
  WEB_SEARCH=on|off
  WEB_SEARCH_MAX_RESULTS=1..5
  WEB_SEARCH_URL=（可选，留空直连 api.deepseek.com/v1/tools）

这个插件不转发搜索请求，只做「开关 + 参数 + 测试」：
把上面几行安全地合并进机器人 `.env`（保留注释与顺序），改完提示重启机器人。
"""
import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path

TOOLS_BASE = "https://api.deepseek.com/v1/tools"
DEFAULT_MAX = 5


def _bot_dir(config):
    raw = str(config.get("bot.dir") or "").strip()
    return Path(raw) if raw else None


def _env_path(config):
    bot = _bot_dir(config)
    return (bot / ".env") if bot else None


def _read(path):
    try:
        return path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return ""


def _parse(text):
    out = {}
    for line in text.splitlines():
        s = line.strip()
        if not s or s.startswith("#") or "=" not in s:
            continue
        k, v = s.split("=", 1)
        out[k.strip()] = v.strip()
    return out


def _merge_write(path, patch):
    """只改已有键的值，缺的键补在末尾；注释、空行、顺序都不动。"""
    lines = _read(path).splitlines()
    left = dict(patch)
    for i, line in enumerate(lines):
        s = line.strip()
        if not s or s.startswith("#") or "=" not in s:
            continue
        k = s.split("=", 1)[0].strip()
        if k in left:
            lines[i] = f"{k}={left.pop(k)}"
    if left:
        if lines and lines[-1].strip():
            lines.append("")
        lines.append("# ===== 联网搜索（由管家「联网搜索」插件维护）=====")
        for k, v in left.items():
            lines.append(f"{k}={v}")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")


def _post(url, body, key, timeout=12):
    req = urllib.request.Request(url, data=json.dumps(body).encode("utf-8"), method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("Authorization", f"Bearer {key}")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:200]
        raise RuntimeError(f"HTTP {exc.code} {detail}") from exc


def register(ctx):
    config = ctx["config"]

    def _key(values):
        return values.get("DEEPSEEK_API_KEY") or os.environ.get("DEEPSEEK_API_KEY", "")

    def status(payload=None):
        env = _env_path(config)
        if not env:
            return {"ok": False, "error": "还没设置机器人目录，先在「设置 → 机器人目录」里选一下包含 index.js 的文件夹"}
        values = _parse(_read(env))
        return {
            "ok": True,
            "botDir": str(_bot_dir(config)),
            "envPath": str(env),
            "enabled": str(values.get("WEB_SEARCH", "")).lower() in ("on", "1", "true", "yes"),
            "maxResults": int(values.get("WEB_SEARCH_MAX_RESULTS") or DEFAULT_MAX),
            "hasKey": bool(_key(values)),
            "endpoint": TOOLS_BASE,
        }

    def save(payload=None):
        env = _env_path(config)
        if not env:
            return {"ok": False, "error": "还没设置机器人目录"}
        payload = payload or {}
        enabled = bool(payload.get("enabled"))
        try:
            max_results = max(1, min(5, int(payload.get("maxResults") or DEFAULT_MAX)))
        except (TypeError, ValueError):
            max_results = DEFAULT_MAX
        _merge_write(
            env,
            {
                "WEB_SEARCH": "on" if enabled else "off",
                "WEB_SEARCH_MAX_RESULTS": str(max_results),
            },
        )
        ctx["log"](f"联网搜索：{'开' if enabled else '关'}，每次 {max_results} 条")
        out = status()
        out["changed"] = True
        return out

    def test(payload=None):
        env = _env_path(config)
        if not env:
            return {"ok": False, "error": "还没设置机器人目录"}
        query = str((payload or {}).get("query") or "").strip()
        if not query:
            return {"ok": False, "error": "先输入要搜的内容"}
        key = _key(_parse(_read(env)))
        if not key:
            return {"ok": False, "error": "机器人 .env 里没有 DEEPSEEK_API_KEY，先去「机器人配置」填好"}
        t0 = time.time()
        try:
            data = _post(f"{TOOLS_BASE}/search", {"query": query, "count": 3, "need_content": False}, key)
        except Exception as exc:  # noqa: BLE001 - 插件边界，错误原样回给界面
            ctx["log"](f"联网搜索测试失败：{exc}", "warn")
            return {"ok": False, "error": str(exc)}
        items = []
        for r in (data.get("results") or [])[:3]:
            snippet = str(r.get("snippet") or r.get("summary") or "").replace("\n", " ").strip()
            items.append(
                {
                    "title": str(r.get("title") or "(无标题)"),
                    "url": str(r.get("url") or ""),
                    "snippet": snippet[:200],
                    "date": str(r.get("date") or "")[:10],
                }
            )
        ctx["log"](f"联网搜索测试：{query} → {len(items)} 条")
        return {"ok": True, "query": query, "ms": int((time.time() - t0) * 1000), "results": items}

    return {"status": status, "save": save, "test": test}
