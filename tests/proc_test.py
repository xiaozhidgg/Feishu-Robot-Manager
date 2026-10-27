import sys, time
sys.path.insert(0, ".")
from app.main import ManagerApp
a = ManagerApp()
api = a.api
print("启动:", api.start_bot())
time.sleep(4)
st = api.get_status()
print("状态:", st)
logs = api.get_logs(0)
print("日志条数:", len(logs))
for i in logs[-6:]:
    print("   ", i["source"], "|", i["text"][:80])
print("停止:", api.stop_bot())
time.sleep(1.5)
print("停止后:", api.get_status())
