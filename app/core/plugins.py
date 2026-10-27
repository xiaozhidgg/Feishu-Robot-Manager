"""插件系统。

两半：
  · 前端插件 —— `plugin.js` 里调 window.FBM.registerPlugin({...})，能加标签页、按钮、面板，刷新即生效
  · 后端插件 —— `backend.py` 里写 register(ctx) 返回 {方法名: 函数}，前端通过 plugin_call 调
改插件不需要重新打包 exe。

目录结构：
  plugins/
    hello/
      plugin.json     {"id":"hello","name":"示例","version":"1.0.0","ui":"plugin.js","backend":"backend.py"}
      plugin.js
      backend.py
"""
from __future__ import annotations

import base64
import importlib.util
import io
import json
import re
import shutil
import tempfile
import traceback
import zipfile
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from .config import app_dir

# 拖入导入的上限：插件本来就小，超过这个量级基本是拖错了东西
MAX_IMPORT_BYTES = 40 * 1024 * 1024
MAX_IMPORT_FILES = 3000
NAME_RE = re.compile(r"^[A-Za-z0-9._-]+$")


class PluginHost:
    def __init__(self, config, logs) -> None:
        self.config = config
        self.logs = logs
        self.dir = app_dir() / "plugins"
        self.dir.mkdir(parents=True, exist_ok=True)
        self._backends: Dict[str, Dict[str, Callable]] = {}
        self._errors: Dict[str, str] = {}

    # ------------------------------------------------------------------ 扫描
    def _manifest(self, folder: Path) -> Optional[Dict[str, Any]]:
        f = folder / "plugin.json"
        if not f.exists():
            return None
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
        except Exception as exc:
            self._errors[folder.name] = f"plugin.json 解析失败：{exc}"
            return None
        data.setdefault("id", folder.name)
        return data

    def _disabled(self) -> List[str]:
        return list(self.config.get("plugins.disabled", []) or [])

    def reload(self) -> None:
        """丢掉已加载的后端和上一轮扫描的报错，下次调用重新读一遍。

        清 `_errors` 很重要：插件作者改好 plugin.json 再点「重新加载」，
        不清的话界面上还挂着上一轮的解析错误。
        """
        self._backends.clear()
        self._errors.clear()

    def list(self) -> List[Dict[str, Any]]:
        out = []
        disabled = self._disabled()
        self._errors.clear()
        for folder in sorted(self.dir.iterdir()):
            if not folder.is_dir():
                continue
            m = self._manifest(folder)
            if not m:
                continue
            pid = m["id"]
            out.append(
                {
                    "id": pid,
                    "name": m.get("name", pid),
                    "version": m.get("version", "0.0.0"),
                    "description": m.get("description", ""),
                    "author": m.get("author", ""),
                    "hasUi": bool(m.get("ui")),
                    "hasBackend": bool(m.get("backend")),
                    "tab": m.get("tab"),
                    "enabled": pid not in disabled,
                    "error": self._errors.get(pid) or self._errors.get(folder.name),
                    "path": str(folder),
                }
            )
        return out

    # ------------------------------------------------------------------ 前端
    def ui_payload(self) -> List[Dict[str, Any]]:
        """把启用的前端插件源码交给界面注入，绕开 file:// 的跨域限制。"""
        out = []
        disabled = self._disabled()
        for folder in sorted(self.dir.iterdir()):
            if not folder.is_dir():
                continue
            m = self._manifest(folder)
            if not m or m["id"] in disabled:
                continue
            item = {"id": m["id"], "name": m.get("name", m["id"]), "js": "", "css": ""}
            if m.get("ui"):
                p = folder / m["ui"]
                if p.exists():
                    item["js"] = p.read_text(encoding="utf-8")
            if m.get("css"):
                p = folder / m["css"]
                if p.exists():
                    item["css"] = p.read_text(encoding="utf-8")
            if item["js"]:
                out.append(item)
        return out

    # ------------------------------------------------------------------ 后端
    class _ConfigProxy:
        """给插件用的配置视图。用类而不是 dict，否则 ctx["config"].get 会变成 dict.get。"""

        def __init__(self, config) -> None:
            self._config = config

        def get(self, path: str, default=None):
            return self._config.get(path, default)

        def set(self, path: str, value):
            self._config.set(path, value)
            self._config.save()
            return True

        def all(self):
            return self._config.data

    def _ctx(self, pid: str) -> Dict[str, Any]:
        def log(text: str, level: str = "info"):
            self.logs.add(f"[{pid}] {text}", "plugin", level)

        return {"pluginId": pid, "log": log, "config": self._ConfigProxy(self.config)}

    def load_backend(self, pid: str) -> Dict[str, Callable]:
        if pid in self._backends:
            return self._backends[pid]
        folder = self._find_folder(pid)
        if not folder:
            raise RuntimeError(f"找不到插件 {pid}")
        m = self._manifest(folder) or {}
        entry = m.get("backend")
        if not entry:
            raise RuntimeError(f"插件 {pid} 没有后端入口")
        path = folder / entry
        if not path.exists():
            raise RuntimeError(f"后端文件不存在：{path}")

        spec = importlib.util.spec_from_file_location(f"fbm_plugin_{pid}", path)
        if not spec or not spec.loader:
            raise RuntimeError("插件加载失败")
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)

        register = getattr(mod, "register", None)
        methods = register(self._ctx(pid)) if callable(register) else {}
        if not isinstance(methods, dict):
            raise RuntimeError("register() 必须返回 {方法名: 函数}")
        self._backends[pid] = methods
        self.logs.add(f"已加载插件后端 {pid}（{len(methods)} 个方法）", "manager", "info")
        return methods

    def _find_folder(self, pid: str) -> Optional[Path]:
        for folder in self.dir.iterdir():
            if not folder.is_dir():
                continue
            m = self._manifest(folder)
            if m and m.get("id") == pid:
                return folder
        return None

    def call(self, pid: str, method: str, payload: Any = None) -> Dict[str, Any]:
        try:
            methods = self.load_backend(pid)
            fn = methods.get(method)
            if not callable(fn):
                return {"ok": False, "error": f"插件 {pid} 没有方法 {method}"}
            result = fn(payload) if payload is not None else fn()
            return {"ok": True, "data": result}
        except Exception as exc:
            self.logs.add(f"[{pid}] {method} 失败：{exc}", "plugin", "error")
            return {"ok": False, "error": str(exc), "trace": traceback.format_exc(limit=3)}

    def set_enabled(self, pid: str, enabled: bool) -> List[str]:
        disabled = self._disabled()
        if enabled and pid in disabled:
            disabled.remove(pid)
        elif not enabled and pid not in disabled:
            disabled.append(pid)
        self.config.set("plugins.disabled", disabled)
        self.config.save()
        if not enabled:
            self._backends.pop(pid, None)
        return disabled

    # ------------------------------------------------------------------ 拖入导入
    def import_dropped(self, items: List[Dict[str, Any]]) -> Dict[str, Any]:
        """接收界面拖进来的插件（文件夹或 .zip），装到 plugins/ 下。

        items 两种形态：
          {"kind": "folder", "name": "myplugin", "files": [{"rel": "plugin.json", "b64": "..."}]}
          {"kind": "zip",    "name": "myplugin.zip", "b64": "..."}
        界面能拿到的只有内容（拿不到真实路径），所以走 base64 传，落盘后再校验目录结构。
        """
        imported: List[str] = []
        errors: List[str] = []
        if not items:
            return {"ok": False, "error": "没有收到内容", "imported": [], "errors": []}

        work = Path(tempfile.mkdtemp(prefix="fbm-import-"))
        try:
            for index, item in enumerate(items, 1):
                label = str(item.get("name") or f"第 {index} 项")
                try:
                    staged = self._stage_drop(work / f"item{index}", item)
                    pid = self._install_plugin(staged)
                    imported.append(pid)
                    self.logs.add(f"已导入插件 {pid}", "manager", "info")
                except Exception as exc:
                    errors.append(f"{label}：{exc}")
                    self.logs.add(f"导入插件失败（{label}）：{exc}", "manager", "warn")
        finally:
            shutil.rmtree(work, ignore_errors=True)

        if imported:
            self.reload()  # 新插件要能被立刻扫描到
        return {
            "ok": bool(imported),
            "imported": imported,
            "errors": errors,
            "plugins": self.list(),
            "ui": self.ui_payload(),
        }

    def _stage_drop(self, dest: Path, item: Dict[str, Any]) -> Path:
        """把拖进来的内容落到临时目录，返回「插件目录」候选。"""
        kind = str(item.get("kind") or "").lower()
        if kind == "zip":
            dest.mkdir(parents=True)
            self._unzip(self._decode(item.get("b64"), item.get("name")), dest)
            return self._pick_root(dest)
        if kind == "folder":
            files = item.get("files") or []
            if len(files) > MAX_IMPORT_FILES:
                raise RuntimeError("文件太多了")
            root = dest / self._safe_name(item.get("name") or "plugin")
            root.mkdir(parents=True)
            total = 0
            for entry in files:
                rel = self._safe_rel(entry.get("rel") or "")
                if not rel:
                    continue
                data = self._decode(entry.get("b64"), rel)
                total += len(data)
                if total > MAX_IMPORT_BYTES:
                    raise RuntimeError("插件太大了（超过 40 MB）")
                target = root / rel
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
            return root
        raise RuntimeError("只认插件文件夹和 .zip 压缩包")

    def _decode(self, raw: Any, label: Any) -> bytes:
        try:
            return base64.b64decode(str(raw or ""), validate=False)
        except Exception as exc:
            raise RuntimeError(f"内容读不出来（{label}）：{exc}") from exc

    def _safe_name(self, name: str) -> str:
        clean = str(name or "").strip()
        if not NAME_RE.match(clean):
            raise RuntimeError(f"名字里有不支持的字符：{name}")
        return clean

    def _safe_rel(self, rel: str) -> str:
        """校验相对路径：不许绝对路径、不许 ..，统一用 /。"""
        parts = []
        for part in str(rel or "").replace("\\", "/").split("/"):
            if part in ("", "."):
                continue
            if part == ".." or part.endswith(":"):
                raise RuntimeError(f"路径不合法：{rel}")
            parts.append(part)
        return "/".join(parts)

    def _unzip(self, data: bytes, dest: Path) -> None:
        try:
            archive = zipfile.ZipFile(io.BytesIO(data))
        except Exception as exc:
            raise RuntimeError(f"压缩包打不开：{exc}") from exc
        count = 0
        total = 0
        for info in archive.infolist():
            if info.is_dir():
                continue
            count += 1
            if count > MAX_IMPORT_FILES:
                raise RuntimeError("压缩包里文件太多")
            rel = self._safe_rel(info.filename)
            if not rel or rel.split("/")[0] == "__MACOSX":
                continue
            total += info.file_size
            if total > MAX_IMPORT_BYTES:
                raise RuntimeError("插件太大了（超过 40 MB）")
            target = dest / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(info) as src, open(target, "wb") as out:
                shutil.copyfileobj(src, out)

    def _pick_root(self, dest: Path) -> Path:
        """压缩包里常套一层同名目录，往里走两层找 plugin.json。"""
        current = dest
        for _ in range(3):
            if (current / "plugin.json").exists():
                return current
            children = [p for p in current.iterdir() if p.name != "__MACOSX"]
            if len(children) == 1 and children[0].is_dir():
                current = children[0]
                continue
            break
        return current

    def _install_plugin(self, src: Path) -> str:
        manifest_path = src / "plugin.json"
        if not manifest_path.exists():
            raise RuntimeError("里面没有 plugin.json，不像是插件")
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except Exception as exc:
            raise RuntimeError(f"plugin.json 解析失败：{exc}") from exc
        if not isinstance(manifest, dict):
            raise RuntimeError("plugin.json 得是个对象")
        pid = str(manifest.get("id") or src.name).strip()
        if not NAME_RE.match(pid):
            raise RuntimeError(f"插件 id 不合法：{pid}")
        target = self.dir / pid
        if target.exists():
            raise RuntimeError(f"插件 {pid} 已经存在，先删掉旧的再拖进来")
        shutil.copytree(src, target, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        return pid
