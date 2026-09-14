/**
 * dsh-gemini-web — 浏览器侧（独立设置页）。
 *
 * 在「设置」里注册一个**独立分区**「Gemini 网页端」（插槽 `settings.section`），
 * 而不是塞在「插件」列表里。页面复用 harness 的设计令牌（`--dsw-alias-*`），
 * 分卡片展示运行状态、登录账号、操作与配置。
 *
 * 这是手写的客户端模块，使用与内置客户端 bundle 相同的加载格式
 * （window.__ModuleLoader__.load + CommonJS 工厂），不需要打包器：React 从应用
 * 的模块表里 require，样式注入一个带 data-plugin-css 标记的 <style>。
 */
window.__ModuleLoader__.load({
  id: "dsh-gemini-web/client",
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" })
    var react = require("react")
    var useSyncExternalStore = react.useSyncExternalStore
    var h = react.createElement

    /** 插件自有的 HTTP 路由前缀（由 host 侧注册）。 */
    var API = "/plugins/gemini-web"

    /** 注入样式用的唯一标记。 */
    var STYLE_ID = "dsh-gemini-web/settings-page.css"

    /** 页面样式：全部基于 harness 设计令牌，跟随明暗主题。 */
    var CSS = [
      ".gws{display:flex;flex-direction:column;gap:16px;color:var(--dsw-alias-label-primary);padding:2px 2px 24px}",
      ".gws-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap}",
      ".gws-brand{display:flex;align-items:center;gap:12px;min-width:0}",
      ".gws-mark{width:38px;height:38px;border-radius:12px;flex:none;display:grid;place-items:center;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary-invert)}",
      ".gws-title{margin:0;font-size:16px;font-weight:600;line-height:22px}",
      ".gws-sub{margin:3px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}",
      ".gws-badge{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 10px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);font-size:12px;white-space:nowrap}",
      ".gws-badge[data-tone=ok]{color:var(--dsw-alias-state-success-primary)}",
      ".gws-badge[data-tone=warn]{color:var(--dsw-alias-state-warn-primary)}",
      ".gws-badge[data-tone=error]{color:var(--dsw-alias-state-error-primary)}",
      ".gws-badge[data-tone=idle]{color:var(--dsw-alias-label-tertiary)}",
      ".gws-cols{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(300px,1fr))}",
      ".gws-card{display:flex;flex-direction:column;gap:12px;padding:16px;border-radius:14px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1)}",
      ".gws-card-title{margin:0;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}",
      ".gws-rows{display:flex;flex-direction:column;gap:9px;margin:0;padding:0;list-style:none}",
      ".gws-row{display:flex;align-items:flex-start;gap:9px;font-size:13px;line-height:18px;min-width:0}",
      ".gws-dot{width:8px;height:8px;border-radius:50%;flex:none;margin-top:5px;background:var(--dsw-alias-label-tertiary)}",
      ".gws-dot[data-tone=ok]{background:var(--dsw-alias-state-success-primary)}",
      ".gws-dot[data-tone=warn]{background:var(--dsw-alias-state-warn-primary)}",
      ".gws-dot[data-tone=error]{background:var(--dsw-alias-state-error-primary)}",
      ".gws-row-key{flex:none;width:52px;color:var(--dsw-alias-label-secondary);font-size:12px;margin-top:1px}",
      ".gws-row-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}",
      ".gws-row-note{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);word-break:break-word}",
      ".gws-chips{display:flex;flex-wrap:wrap;gap:6px}",
      ".gws-chip{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;padding:3px 8px;border-radius:7px;background:var(--dsw-alias-bg-layer-4);color:var(--dsw-alias-label-secondary)}",
      ".gws-actions{display:flex;flex-direction:column;gap:12px}",
      ".gws-action-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px}",
      ".gws-action-tag{flex:none;width:44px;font-size:11px;color:var(--dsw-alias-label-tertiary)}",
      ".gws-btn{height:32px;padding:0 13px;border-radius:9px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;line-height:1;cursor:pointer;transition:background .12s ease,border-color .12s ease}",
      ".gws-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}",
      ".gws-btn:disabled{opacity:.45;cursor:default}",
      ".gws-btn[data-variant=primary]{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary-invert);border-color:transparent}",
      ".gws-btn[data-variant=ghost]{background:transparent}",
      ".gws-btn[data-variant=danger]:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}",
      ".gws-check{display:inline-flex;align-items:center;gap:7px;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer}",
      ".gws-fields{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(250px,1fr))}",
      ".gws-field{display:flex;flex-direction:column;gap:6px;min-width:0}",
      ".gws-label{font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary)}",
      ".gws-input{box-sizing:border-box;width:100%;height:32px;padding:0 10px;border-radius:9px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px}",
      ".gws-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}",
      ".gws-input:disabled{opacity:.55}",
      ".gws-note{display:flex;align-items:flex-start;gap:8px;margin:0;padding:10px 12px;border-radius:10px;font-size:12px;line-height:17px;background:var(--dsw-alias-bg-layer-1)}",
      ".gws-note[data-tone=ok]{color:var(--dsw-alias-state-success-primary)}",
      ".gws-note[data-tone=error]{color:var(--dsw-alias-state-error-primary)}",
      ".gws-hint{margin:0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}",
      ".gws-sep{height:1px;background:var(--dsw-alias-border-l3);margin:0}"
    ].join("")

    function ensureStyles() {
      if (typeof document === "undefined") return
      if (document.querySelector("style[data-plugin-css=" + JSON.stringify(STYLE_ID) + "]") !== null) return
      var tag = document.createElement("style")
      tag.dataset.plugin = "dsh-gemini-web"
      tag.dataset.pluginCss = STYLE_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    /** 发一个 JSON 请求；HTTP 状态非 2xx 时抛出带后端的错误信息。 */
    function call(path, method, body) {
      return fetch(API + path, {
        method: method,
        headers: body === undefined ? undefined : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body)
      }).then(function (res) {
        return res.json().catch(function () {
          return {}
        }).then(function (json) {
          if (!res.ok) throw new Error(json && json.error ? json.error : "HTTP " + res.status)
          return json
        })
      })
    }

    /** 周期性拉取内核与登录状态。 */
    function useStatus(intervalMs) {
      var state = react.useState({ loading: true, data: null, error: null })
      var setState = state[1]
      var aliveRef = react.useRef(true)
      var load = react.useCallback(function () {
        return call("/status", "GET")
          .then(function (data) {
            if (aliveRef.current) setState({ loading: false, data: data, error: null })
          })
          .catch(function (error) {
            if (aliveRef.current) setState({ loading: false, data: null, error: String(error && error.message ? error.message : error) })
          })
      }, [])
      react.useEffect(function () {
        aliveRef.current = true
        load()
        var timer = setInterval(load, intervalMs)
        return function () {
          aliveRef.current = false
          clearInterval(timer)
        }
      }, [intervalMs, load])
      return { value: state[0], reload: load }
    }

    /** 读 gemini-web 设置命名空间的快照。 */
    function useConfig(scope) {
      var snapshot = useSyncExternalStore(
        function (onChange) { return scope.subscribe(onChange) },
        function () { return scope.getSnapshot() }
      )
      var ready = snapshot.status === "ready" && snapshot.value !== undefined
      return {
        value: ready ? snapshot.value : {},
        writable: snapshot.writable === true && ready,
        ready: snapshot.status === "ready"
      }
    }

    /** 时间戳 → 本地时刻文案。 */
    function clock(ts) {
      if (!ts) return ""
      try {
        return new Date(ts).toLocaleTimeString()
      } catch (error) {
        return ""
      }
    }

    /** 一行「状态点 + 标题 + 内容 + 备注」。 */
    function StatusRow(props) {
      return h(
        "li",
        { className: "gws-row" },
        h("span", { className: "gws-dot", "data-tone": props.tone || "idle" }),
        h("span", { className: "gws-row-key" }, props.label),
        h(
          "span",
          { className: "gws-row-body" },
          h("span", null, props.text),
          props.note ? h("span", { className: "gws-row-note" }, props.note) : null
        )
      )
    }

    /** 卡片容器。 */
    function Card(props) {
      return h("section", { className: "gws-card" }, h("h3", { className: "gws-card-title" }, props.title), props.children)
    }

    /** 配置输入项。 */
    function Field(props) {
      return h(
        "label",
        { className: "gws-field" },
        h("span", { className: "gws-label" }, props.label),
        h("input", {
          className: "gws-input",
          type: props.type || "text",
          value: props.value,
          placeholder: props.placeholder,
          disabled: props.disabled,
          min: props.min,
          max: props.max,
          onChange: props.onChange
        })
      )
    }

    /** 按钮。 */
    function Button(props) {
      return h(
        "button",
        {
          type: "button",
          className: "gws-btn",
          "data-variant": props.variant || "default",
          disabled: props.disabled,
          onClick: props.onClick
        },
        props.children
      )
    }

    /** 内核状态行取值。 */
    function kernelRow(data) {
      var kernel = data && data.kernel
      if (!data) return { tone: "idle", text: "读取中…" }
      if (kernel && kernel.running) {
        return {
          tone: "ok",
          text: "运行中 · 端口 " + data.port + " · " + (kernel.models || []).length + " 个模型",
          note: "Cookie 池 " + (kernel.enabled || 0) + "/" + (kernel.cookies || 0) + " 个可用 · 内核 " + data.kernelVersion
        }
      }
      return data.kernelExists
        ? { tone: "warn", text: "未运行", note: "点「重启内核」拉起，或先「下载 / 更新内核」" }
        : { tone: "error", text: "尚未下载反代内核", note: "点「下载 / 更新内核」（走下面的出口代理）" }
    }

    /** 登录状态行取值。 */
    function loginRow(data) {
      var login = data && data.login
      if (!login) return { tone: "idle", text: "状态未知" }
      var tone = login.phase === "ok" ? "ok" : login.phase === "error" ? "error" : login.phase === "idle" ? "idle" : "warn"
      return {
        tone: tone,
        text: login.message,
        note: login.windowOpen ? "登录窗口已打开，完成登录后点「我已完成登录」" : ""
      }
    }

    /** 保活状态行取值。 */
    function keepAliveRow(data) {
      var ka = data && data.keepAlive
      if (!ka) return { tone: "idle", text: "状态未知" }
      if (ka.enabled === false) {
        return { tone: "warn", text: "已关闭", note: "Google 换发登录票后内核会掉登录，需要重新登录" }
      }
      var tone = ka.lastError ? "error" : ka.running ? "ok" : "warn"
      var text = (ka.running ? "运行中" : "待命") + " · 每 " + ka.intervalMinutes + " 分钟检查 · 已回写 " + (ka.pushes || 0) + " 次"
      var note = ka.lastError || (ka.lastPushAt ? "最近回写 " + clock(ka.lastPushAt) : "尚未回写过：Google 还没换发新登录票")
      return { tone: tone, text: text, note: note }
    }

    /** 设置页主体。 */
    function GeminiWebPage(props) {
      var scope = props.scope
      var config = useConfig(scope)
      var status = useStatus(3000)
      var local = react.useState({ busy: "", message: "", error: "" })
      var busy = local[0].busy
      var message = local[0].message
      var error = local[0].error
      var setLocal = local[1]
      var killFirst = react.useState(false)

      /** 执行一个会改后端状态的动作，并把结果写进提示行。 */
      function run(key, fn, describe) {
        setLocal({ busy: key, message: "", error: "" })
        Promise.resolve()
          .then(fn)
          .then(function (result) {
            if (result && result.ok === false) {
              setLocal({ busy: "", message: "", error: result.message || (describe ? describe(result) : "操作未成功") })
              return status.reload()
            }
            setLocal({ busy: "", message: describe ? describe(result) : "完成", error: "" })
            return status.reload()
          })
          .catch(function (err) {
            setLocal({ busy: "", message: "", error: String(err && err.message ? err.message : err) })
          })
      }

      /** 受控字段写入（checkbox 取 checked，number 转数字）。 */
      function setField(field) {
        return function (event) {
          var target = event.target
          var raw = target.type === "checkbox" ? target.checked : target.value
          var next = target.type === "number" ? Number(raw) : raw
          scope.set(field, next).catch(function (err) {
            setLocal({ busy: "", message: "", error: String(err && err.message ? err.message : err) })
          })
        }
      }

      if (!config.ready) {
        return h("div", { className: "gws" }, h("p", { className: "gws-hint" }, "Gemini 网页端设置加载中…"))
      }

      var value = config.value || {}
      var data = status.value.data
      var kernel = kernelRow(data)
      var login = loginRow(data)
      var keep = keepAliveRow(data)
      var account = data && data.kernel ? data.kernel.account : undefined
      var models = data && data.kernel ? data.kernel.models || [] : []
      var awaiting = !!(data && data.login && data.login.phase === "awaiting-confirm")
      var reading = !!(data && data.login && data.login.phase === "reading")
      var disabled = busy !== ""

      return h(
        "div",
        { className: "gws" },

        h(
          "header",
          { className: "gws-head" },
          h(
            "div",
            { className: "gws-brand" },
            h(
              "span",
              { className: "gws-mark", "aria-hidden": "true" },
              h(
                "svg",
                { width: 20, height: 20, viewBox: "0 0 20 20", fill: "none" },
                h("path", { d: "M10 2.2l1.9 5.1 5.1 1.9-5.1 1.9L10 17.8 8.1 11.1 3 9.2l5.1-1.9L10 2.2z", fill: "currentColor" })
              )
            ),
            h(
              "div",
              null,
              h("h2", { className: "gws-title" }, "Gemini 网页端"),
              h("p", { className: "gws-sub" }, "把 gemini.google.com 接进 DSH：托管反代内核、免粘贴登录、自动保活 cookie")
            )
          ),
          h(
            "span",
            { className: "gws-badge", "data-tone": kernel.tone },
            h("span", { className: "gws-dot", "data-tone": kernel.tone, style: { marginTop: 0 } }),
            kernel.tone === "ok" ? "内核运行中" : kernel.text
          )
        ),

        h(
          "div",
          { className: "gws-cols" },
          h(
            Card,
            { title: "运行状态" },
            h(
              "ul",
              { className: "gws-rows" },
              h(StatusRow, { label: "内核", tone: kernel.tone, text: kernel.text, note: kernel.note }),
              h(StatusRow, { label: "登录", tone: login.tone, text: login.text, note: login.note }),
              h(StatusRow, { label: "保活", tone: keep.tone, text: keep.text, note: keep.note })
            )
          ),
          h(
            Card,
            { title: "登录账号" },
            account
              ? h(
                "ul",
                { className: "gws-rows" },
                h(StatusRow, {
                  label: "账号",
                  tone: account.health === "ok" ? "ok" : "warn",
                  text: "#" + account.id + " · " + (account.health === "ok" ? "登录态正常" : "健康度 " + account.health),
                  note: account.label
                }),
                h(StatusRow, {
                  label: "登录票",
                  tone: account.hasPsidts ? "ok" : "error",
                  text: account.hasPsidts ? "含 __Secure-1PSIDTS" : "缺 __Secure-1PSIDTS",
                  note: account.hasPsidts ? "保活会自动跟随 Google 的换发节奏" : "需要重新登录 Google"
                })
              )
              : h("p", { className: "gws-hint" }, "还没有登录账号：点下面的「登录 Google」开始。"),
            models.length > 0
              ? h(
                "div",
                { className: "gws-chips" },
                models.map(function (model) {
                  return h("span", { className: "gws-chip", key: model }, model)
                })
              )
              : null
          )
        ),

        h(
          Card,
          { title: "操作" },
          h(
            "div",
            { className: "gws-actions" },
            h(
              "div",
              { className: "gws-action-row" },
              h("span", { className: "gws-action-tag" }, "登录"),
              h(
                Button,
                {
                  variant: "primary",
                  disabled: disabled || reading,
                  onClick: function () { run("login", function () { return call("/login", "POST", {}) }, function () { return "已打开浏览器窗口：登录完成后点「我已完成登录」" }) }
                },
                awaiting ? "重新打开登录窗口" : "登录 Google"
              ),
              h(
                Button,
                {
                  disabled: disabled || !awaiting,
                  onClick: function () { run("confirm", function () { return call("/login/confirm", "POST", {}) }, function (r) { return (r && r.message) || "已读取 cookie" }) }
                },
                busy === "confirm" ? "读取 cookie…" : "我已完成登录"
              ),
              h(
                Button,
                { variant: "ghost", disabled: disabled || !awaiting, onClick: function () { run("cancel", function () { return call("/login/cancel", "POST", {}) }, function () { return "已取消登录" }) } },
                "取消"
              ),
              h(
                Button,
                { variant: "danger", disabled: disabled, onClick: function () { run("logout", function () { return call("/logout", "POST", {}) }, function () { return "已退出登录并清空 Cookie 池" }) } },
                "退出登录"
              )
            ),
            h(
              "div",
              { className: "gws-action-row" },
              h("span", { className: "gws-action-tag" }, "导入"),
              h(
                Button,
                {
                  disabled: disabled,
                  onClick: function () {
                    run("import", function () { return call("/import/system", "POST", { killFirst: killFirst[0] === true }) }, function (r) { return (r && r.message) || "已导入系统浏览器的登录态" })
                  }
                },
                busy === "import" ? "导入中…" : "导入系统浏览器登录态"
              ),
              h(
                "label",
                { className: "gws-check" },
                h("input", { type: "checkbox", checked: killFirst[0] === true, onChange: function (event) { killFirst[1](event.target.checked) } }),
                h("span", null, "导入前先自动关闭浏览器")
              )
            ),
            h("div", { className: "gws-sep" }),
            h(
              "div",
              { className: "gws-action-row" },
              h("span", { className: "gws-action-tag" }, "保活"),
              h(
                Button,
                {
                  disabled: disabled,
                  onClick: function () { run("keepalive", function () { return call("/keepalive/now", "POST", {}) }, function (r) { return (r && r.message) || "已检查保活状态" }) }
                },
                busy === "keepalive" ? "保活中…" : "立即保活"
              ),
              h("span", { className: "gws-hint" }, "让常驻无窗口浏览器跑一轮，把 Google 换发后的登录票回写内核")
            ),
            h(
              "div",
              { className: "gws-action-row" },
              h("span", { className: "gws-action-tag" }, "内核"),
              h(
                Button,
                { disabled: disabled, onClick: function () { run("restart", function () { return call("/kernel/restart", "POST", {}) }, function (r) { return "内核已重启，模型 " + ((r && r.models) || []).length + " 个" }) } },
                busy === "restart" ? "重启中…" : "重启内核"
              ),
              h(
                Button,
                { disabled: disabled, onClick: function () { run("install", function () { return call("/kernel/install", "POST", {}) }, function (r) { return "内核已下载（" + Math.round(((r && r.bytes) || 0) / 1048576) + " MB）" }) } },
                busy === "install" ? "下载中…" : "下载 / 更新内核"
              ),
              h(
                Button,
                { disabled: disabled, onClick: function () { run("test", function () { return call("/test", "POST", {}) }, function (r) { return r && r.ok ? "连通性正常" : "连通性失败：" + ((r && (r.detail || r.error)) || "未知原因") }) } },
                busy === "test" ? "测试中…" : "连通性测试"
              )
            )
          )
        ),

        h(
          Card,
          { title: "设置" },
          h(
            "div",
            { className: "gws-action-row" },
            h(
              "label",
              { className: "gws-check" },
              h("input", { type: "checkbox", checked: value.enabled !== false, disabled: !config.writable, onChange: setField("enabled") }),
              h("span", null, "启用 Gemini 网页端 provider")
            ),
            h(
              "label",
              { className: "gws-check" },
              h("input", { type: "checkbox", checked: value.keepAliveEnabled !== false, disabled: !config.writable, onChange: setField("keepAliveEnabled") }),
              h("span", null, "自动保活 cookie")
            )
          ),
          h(
            "div",
            { className: "gws-fields" },
            h(Field, {
              label: "保活检查间隔（分钟，1–120）",
              type: "number",
              min: 1,
              max: 120,
              value: String(value.keepAliveIntervalMinutes === undefined ? 5 : value.keepAliveIntervalMinutes),
              disabled: !config.writable,
              onChange: setField("keepAliveIntervalMinutes")
            }),
            h(Field, {
              label: "出口代理",
              value: value.proxyUrl || "",
              placeholder: "http://127.0.0.1:7897",
              disabled: !config.writable,
              onChange: setField("proxyUrl")
            }),
            h(Field, {
              label: "浏览器路径",
              value: value.browserPath || "",
              placeholder: "留空自动探测 Chrome / Edge",
              disabled: !config.writable,
              onChange: setField("browserPath")
            }),
            h(Field, {
              label: "反代内核路径",
              value: value.kernelPath || "",
              placeholder: "留空用 ~/.dsh/gemini-web/bin/",
              disabled: !config.writable,
              onChange: setField("kernelPath")
            }),
            h(Field, {
              label: "内核端口（0 = 自动）",
              type: "number",
              min: 0,
              value: String(value.port === undefined ? 0 : value.port),
              disabled: !config.writable,
              onChange: setField("port")
            })
          ),
          h("p", { className: "gws-hint" }, "网页端模型没有真正的 function calling（上游是 prompt 级实现），建议作为问答 / 生图线路使用。")
        ),

        message ? h("p", { className: "gws-note", "data-tone": "ok" }, message) : null,
        error ? h("p", { className: "gws-note", "data-tone": "error" }, error) : null,
        data && data.baseUrl ? h("p", { className: "gws-hint" }, "Base URL：" + data.baseUrl) : null
      )
    }

    /**
     * 浏览器插件入口：在「设置」里注册一个独立分区。
     * @param ctx - 客户端 cordis 上下文。
     */
    function apply(ctx) {
      ensureStyles()
      var scope = ctx.settingsScope.bind({ namespace: "gemini-web" })
      ctx.slots.inject("settings.section", function () {
        return ctx.slots.register(
          {
            name: "settings.section",
            id: "gemini-web",
            order: 25,
            label: function () { return "Gemini 网页端" }
          },
          function GeminiWebSection() {
            return h(GeminiWebPage, { scope: scope })
          }
        )
      })
    }

    exports.name = "gemini-web-ui"
    exports.apply = apply
    // 这里必须写 cordis 服务名（不是包名），否则插件会一直 pending 并卡住 web 启动。
    exports.inject = ["slots", "settingsScope"]
    return module.exports
  }
})
