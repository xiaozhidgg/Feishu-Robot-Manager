/* NAS 同步插件（前端）
 * 界面沿用管家已有组件（.card / .card-head / .field / .btn / .code），
 * 所有文件操作都在 backend.py，这里只负责调用与展示。
 */
FBM.registerPlugin({
  id: "nas-sync",
  name: "NAS 同步",
  tab: { title: "NAS 同步" },

  mount(root, ctx) {
    root.innerHTML = `
      <div class="card">
        <div class="card-head">
          <h2>文档清单同步到 NAS</h2>
          <span class="hint ns-state" id="nsState">检测中…</span>
        </div>
        <div class="row-desc" style="line-height:1.9;margin-bottom:12px">
          把本机的 <code>docs.json</code> 写到 NAS 上机器人挂载的 <code>data</code> 目录。<br>
          上传前校验 JSON，写完立刻回读核对条数；容器正在跑也不怕，用的是「先写临时文件再替换」。
        </div>

        <div class="ns-grid">
          <div class="ns-col">
            <div class="ns-k">本机（源）</div>
            <div class="ns-v" id="nsLocal">—</div>
          </div>
          <div class="ns-col">
            <div class="ns-k">NAS（目标）</div>
            <div class="ns-v" id="nsRemote">—</div>
          </div>
        </div>

        <div class="field">
          <label>NAS 目录（UNC 或映射盘符）</label>
          <input id="nsDir" type="text" spellcheck="false" autocomplete="off">
        </div>
        <div class="field" style="margin-top:10px">
          <label>重启命令（可选，填了才能一键重启）</label>
          <input id="nsRestart" type="text" spellcheck="false" autocomplete="off">
        </div>
        <label class="ns-check">
          <input type="checkbox" id="nsAuto">
          <span>上传成功后自动执行重启命令</span>
        </label>

        <div class="plugin-tags" style="margin-top:12px">
          <button class="btn" id="nsSave">保存设置</button>
          <button class="btn" id="nsTest">测试连接</button>
          <button class="btn primary" id="nsUpload">上传文档清单</button>
          <button class="btn" id="nsRestartBtn">重启机器人</button>
        </div>

        <pre class="code" id="nsOut" style="margin-top:12px;min-height:88px">就绪。</pre>
      </div>`;

    const $n = (id) => root.querySelector("#" + id);
    $n("nsDir").placeholder = "\\\\jiuyeyunpan\\docker\\FeishuBot\\data";
    $n("nsRestart").placeholder = 'ssh root@192.168.1.2 "docker restart feishu-bot"';

    const out = $n("nsOut");
    const state = $n("nsState");
    const buttons = ["nsSave", "nsTest", "nsUpload", "nsRestartBtn"].map($n);

    const say = (text) => { out.textContent = text; out.scrollTop = out.scrollHeight; };
    const busy = (on) => buttons.forEach((b) => { b.disabled = !!on; });

    function paint(res) {
      if (!res || !res.ok) {
        state.textContent = "检测失败";
        state.className = "hint ns-state bad";
        say((res && res.error) || "读取状态失败");
        return;
      }
      const s = res.settings || {};
      $n("nsDir").value = s.dir || "";
      $n("nsRestart").value = s.restart || "";
      $n("nsAuto").checked = !!s.autoRestart;

      const L = res.local || {};
      const R = res.remote || {};
      $n("nsLocal").innerHTML = L.exists
        ? `<b>${L.count}</b> 条 · ${L.mtime || ""}<div class="ns-path">${L.path}</div>`
        : `<span class="ns-warn">没找到 docs.json</span>`;
      $n("nsRemote").innerHTML = R.exists
        ? `<b>${R.count}</b> 条 · ${R.mtime || ""}<div class="ns-path">${R.path}</div>`
        : `<span class="ns-warn">${res.dir_exists ? "目录里没有 docs.json" : "目录打不开"}</span>`;

      if (res.same) {
        state.textContent = "已同步"; state.className = "hint ns-state ok";
      } else if (R.exists) {
        state.textContent = "两边不一致"; state.className = "hint ns-state warn";
      } else {
        state.textContent = "NAS 上还没有"; state.className = "hint ns-state warn";
      }
    }

    async function reload() {
      try {
        paint(await ctx.pluginCall("status"));
      } catch (err) {
        state.textContent = "检测失败";
        state.className = "hint ns-state bad";
        say("读取状态失败：" + err.message);
      }
    }

    async function run(button, label, work) {
      busy(true);
      say(label + "…");
      try {
        return await work();
      } catch (err) {
        say(label + "失败：" + err.message);
        return null;
      } finally {
        busy(false);
      }
    }

    $n("nsTest").addEventListener("click", () =>
      run($n("nsTest"), "正在读两边", async () => {
        await reload();
        say("已刷新状态。");
      }));

    $n("nsSave").addEventListener("click", () =>
      run($n("nsSave"), "正在保存", async () => {
        const res = await ctx.pluginCall("save", {
          dir: $n("nsDir").value.trim(),
          restart: $n("nsRestart").value.trim(),
          autoRestart: $n("nsAuto").checked,
        });
        if (res && res.ok) { say("设置已保存。"); ctx.toast("设置已保存"); await reload(); }
        else say((res && res.error) || "保存失败");
      }));

    $n("nsUpload").addEventListener("click", () =>
      run($n("nsUpload"), "正在上传", async () => {
        const res = await ctx.pluginCall("upload");
        if (!res || !res.ok) {
          say((res && res.error) || "上传失败");
          ctx.toast("上传失败");
        } else {
          let t = `已上传 ${res.uploaded} 条文档清单\n来源：${res.source}\n目标：${res.target}`;
          if (res.restart) {
            t += `\n\n重启容器：${res.restart.ok ? "成功" : "失败"}\n${res.restart.output || ""}`;
          } else if (res.hint) {
            t += `\n\n${res.hint}`;
          }
          say(t);
          ctx.toast("已同步到 NAS");
        }
        await reload();
      }));

    $n("nsRestartBtn").addEventListener("click", () =>
      run($n("nsRestartBtn"), "正在执行重启命令", async () => {
        const res = await ctx.pluginCall("restart");
        if (res && res.ok) say("重启命令已执行：\n" + (res.output || "（无输出）"));
        else say((res && res.error) || "重启失败");
        await reload();
      }));

    reload();
  },
});
