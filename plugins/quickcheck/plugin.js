/* 演示插件：前端加一个标签页 */
FBM.registerPlugin({
  id: "quickcheck",
  name: "环境体检",
  tab: { title: "环境体检" },

  mount(root, ctx) {
    root.innerHTML = `
      <div class="card">
        <div class="card-head">
          <h2>运行环境</h2>
          <span class="hint">数据来自后端 Python 插件</span>
        </div>
        <div class="plugin-tags" style="margin-bottom:12px">
          <button class="btn primary" data-act="run">重新检测</button>
        </div>
        <pre class="code" data-out style="min-height:150px">点上面的按钮开始检测…</pre>
      </div>
      <div class="card">
        <div class="card-head"><h2>这个插件能做什么</h2></div>
        <div class="row-desc" style="line-height:1.9">
          · 前端部分（plugin.js）负责往侧栏加标签页、画界面<br>
          · 后端部分（backend.py）负责跑 Python，能读文件、起进程、发请求<br>
          · 两边通过 ctx.pluginCall('方法名', 参数) 通信<br>
          · 改完点「插件」页的「重新加载」立刻生效，不用重打包
        </div>
      </div>`;

    const out = root.querySelector("[data-out]");
    root.querySelector('[data-act="run"]').addEventListener("click", async () => {
      out.textContent = "检测中…";
      const res = await ctx.pluginCall("info");
      if (!res || !res.ok) {
        out.textContent = "调用失败：" + (res && res.error ? res.error : "未知错误");
        return;
      }
      const d = res.data || {};
      out.textContent = Object.entries(d)
        .map(([k, v]) => `${k.padEnd(14)} ${v}`)
        .join("\n");
      ctx.toast("检测完成");
    });
  },
});
