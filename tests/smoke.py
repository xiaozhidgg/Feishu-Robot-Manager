"""不开窗口的自检：验证配置、日志、插件、环境体检这些不依赖 GUI 的部分。"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.api import Api
from app.core import envfile
from app.core.config import Config
from app.core.logs import LogStore
from app.core.plugins import PluginHost
from app.core.process import BotProcess

print("== config ==")
cfg = Config()
print("bot.dir :", cfg.get("bot.dir"))
print("animation:", cfg.get("ui.animation"))

print("\n== envfile ==")
src = "# 注释保留\nFEISHU_APP_ID=cli_old\nDEEPSEEK_MODEL=deepseek-flash\n"
out = envfile.merge(src, {"FEISHU_APP_ID": "cli_new", "BOT_NAME": "小九"})
print(out)
assert "cli_new" in out and "# 注释保留" in out and "BOT_NAME=小九" in out
print("merge ok, parse ->", envfile.parse(out))

print("\n== logs ==")
logs = LogStore(max_lines=50)
logs.add("测试一行", "manager")
logs.add("[error] 出错了", "bot")
print("since(0) ->", len(logs.since(0)), "条；级别推断：", [i["level"] for i in logs.since(0)])

print("\n== process ==")
bot = BotProcess(cfg, logs)
print("preflight:", json.dumps(bot.preflight(), ensure_ascii=False))
print("status:", json.dumps(bot.status(), ensure_ascii=False))

print("\n== plugins ==")
host = PluginHost(cfg, logs)
for p in host.list():
    print(f"  {p['id']} v{p['version']} ui={p['hasUi']} backend={p['hasBackend']} err={p['error']}")
res = host.call("quickcheck", "info")
print("plugin_call ->", json.dumps(res, ensure_ascii=False)[:300])

print("\n== api ==")
api = Api(cfg, logs, bot, host)
b = api.bootstrap()
print("bootstrap keys:", sorted(b.keys()))
print("env path:", api.get_env().get("path"))
print("docs path:", api.get_docs().get("path"))

print("\n全部自检通过")
