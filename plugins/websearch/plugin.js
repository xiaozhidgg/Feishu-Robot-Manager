/* 联网搜索插件：开关 + 参数 + 测试台（搜索能力在机器人侧，用 DeepSeek 官方 Search API） */
FBM.registerPlugin({
  id: "websearch",
  name: "联网搜索",
  tab: { title: "联网搜索" },

  mount(root, ctx) {
    root.innerHTML = `
      <div class="card">
        <div class="card-head">
          <h2>机器人联网搜索</h2>
          <span class="hint">用机器人自己的 DeepSeek Key，不需要额外注册搜索服务</span>
        </div>

        <div class="field-row" style="align-items:center;gap:14px">
          <div style="flex:1">
            <div class="row-title">启用联网搜索</div>
            <div class="row-desc">打开后，机器人遇到需要实时信息的问题会自动搜索，并在回答里给出链接</div>
          </div>
          <label class="switch"><input type="checkbox" id="wsEnabled"><span></span></label>
        </div>

        <div class="field-row" style="align-items:center;gap:14px;margin-top:6px">
          <div style="flex:1">
            <div class="row-title">每次返回结果数</div>
            <div class="row-desc">1~5 条。条数越多越完整，也越费额度</div>
          </div>
          <select class="input" id="wsMax" style="width:96px">
            <option value="1">1 条</option>
            <option value="3">3 条</option>
            <option value="5">5 条</option>
          </select>
        </div>

        <div class="plugin-tags" style="margin-top:14px">
          <button class="btn primary" id="wsSave">保存</button>
          <button class="btn" id="wsRestart">保存并重启机器人</button>
        </div>

        <pre class="code" id="wsState" style="margin-top:12px">读取中…</pre>
      </div>

      <div class="card">
        <div class="card-head">
          <h2>试一下</h2>
          <span class="hint">直接调官方搜索接口，验证 Key 和网络是否通</span>
        </div>
        <div class="input-with-btn" style="margin-bottom:12px">
          <input class="input" id="wsQuery" placeholder="比如：DeepSeek 最新模型发布了什么">
          <button class="btn primary" id="wsTest">搜索</button>
        </div>
        <div id="wsResults" class="row-desc">还没有测试结果。</div>
      </div>`;

    const $ = (sel) => root.querySelector(sel);
    const enabled = $("#wsEnabled");
    const maxSel = $("#wsMax");
    const state = $("#wsState");
    const results = $("#wsResults");
    let current = null;

    function renderState(d) {
      current = d;
      enabled.checked = !!d.enabled;
      const n = String(d.maxResults || 5);
      if ([...maxSel.options].some((o) => o.value === n)) maxSel.value = n;
      state.textContent = [
        `机器人目录   ${d.botDir || "(未设置)"}`,
        `配置文件     ${d.envPath || "-"}`,
        `DeepSeek Key ${d.hasKey ? "已配置 ✓" : "缺失 ✗（先去「机器人配置」填写并保存）"}`,
        `当前状态     ${d.enabled ? "已开启" : "已关闭"} · 每次 ${d.maxResults} 条`,
        `搜索接口     ${d.endpoint}`,
      ].join("\n");
      if (!d.hasKey) results.textContent = "Key 还没配：先去「机器人配置」把 DeepSeek API Key 填好，再回来测试。";
    }

    function $$(sel) {
      return [...root.querySelectorAll(sel)];
    }

    async function refresh() {
      const res = await ctx.pluginCall("status");
      if (!res || !res.ok) {
        state.textContent = "读取失败：" + (res && res.error ? res.error : "未知错误");
        return;
      }
      renderState(res.data || {});
    }

    async function save(restart) {
      const payload = { enabled: enabled.checked, maxResults: Number(maxSel.value) };
      const res = await ctx.pluginCall("save", payload);
      if (!res || !res.ok) {
        ctx.toast("保存失败：" + (res && res.error ? res.error : "未知错误"));
        return;
      }
      renderState(res.data || {});
      ctx.toast(`已保存：${enabled.checked ? "开启" : "关闭"}，每次 ${payload.maxResults} 条`);
      if (restart) {
        const r = await ctx.api("restart_bot");
        ctx.toast(r && r.ok === false ? `重启失败：${r.message || "未知错误"}` : "机器人已重启，新设置生效");
      } else {
        ctx.toast("改完记得重启机器人，否则还是旧设置");
      }
    }

    async function test() {
      const query = $("#wsQuery").value.trim();
      if (!query) {
        ctx.toast("先输入要搜的内容");
        return;
      }
      results.innerHTML = `<div class="row-desc">搜索中…</div>`;
      const res = await ctx.pluginCall("test", { query });
      if (!res || !res.ok) {
        results.innerHTML = `<div class="row-desc" style="color:#e5a0a0">失败：${(res && res.error) || "未知错误"}</div>`;
        return;
      }
      const d = res.data || {};
      const items = d.results || [];
      if (!items.length) {
        results.innerHTML = `<div class="row-desc">没有搜到结果，换个关键词试试。</div>`;
        return;
      }
      results.innerHTML =
        `<div class="row-desc" style="margin-bottom:8px">「${d.query}」· ${items.length} 条 · ${d.ms} ms</div>` +
        items
          .map(
            (it, i) => `
          <div class="doc-row" style="display:block;padding:10px 12px;margin-bottom:8px">
            <div class="doc-main">
              <b>${i + 1}. ${it.title}</b>
              ${it.date ? `<span class="doc-tag">${it.date}</span>` : ""}
            </div>
            <div class="row-desc" style="margin:4px 0 6px">${it.snippet}</div>
            <a class="link" href="#" data-url="${it.url}">${it.url}</a>
          </div>`,
          )
          .join("");
      $$("#wsResults a[data-url]").forEach((a) =>
        a.addEventListener("click", (e) => {
          e.preventDefault();
          ctx.api("open_url", a.dataset.url);
        }),
      );
    }

    $("#wsSave").addEventListener("click", () => save(false));
    $("#wsRestart").addEventListener("click", () => save(true));
    $("#wsTest").addEventListener("click", test);
    $("#wsQuery").addEventListener("keydown", (e) => {
      if (e.key === "Enter") test();
    });

    refresh();
  },
});
