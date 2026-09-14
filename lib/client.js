/**
 * dsh-gemini-web — 浏览器侧（设置卡片）。
 *
 * 在「设置 → 插件 → Gemini 网页端」里提供：内核与登录状态、免粘贴登录按钮、
 * 退出登录、重启/下载内核、连通性测试，以及插件配置项（走 gemini-web 设置命名空间）。
 *
 * 这是手写的客户端模块，使用与内置客户端 bundle 相同的加载格式
 * （window.__ModuleLoader__.load + CommonJS 工厂），不需要打包器：React 从应用
 * 的模块表里 require，样式直接内联。
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

    var styles = {
      card: { display: "flex", flexDirection: "column", gap: "14px" },
      row: { display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" },
      label: { fontSize: "12px", fontWeight: 500, color: "var(--dsw-alias-label-secondary)" },
      hint: { fontSize: "11px", color: "var(--dsw-alias-label-caption)", lineHeight: "16px" },
      value: { fontSize: "13px", color: "var(--dsw-alias-label-primary)" },
      button: {
        padding: "6px 12px",
        borderRadius: "8px",
        border: "1px solid var(--dsw-alias-border-l1)",
        background: "var(--dsw-alias-bg-layer-1)",
        color: "var(--dsw-alias-label-primary)",
        fontSize: "13px",
        cursor: "pointer"
      },
      primary: {
        padding: "6px 12px",
        borderRadius: "8px",
        border: "1px solid transparent",
        background: "#4d6bfe",
        color: "#fff",
        fontSize: "13px",
        fontWeight: 500,
        cursor: "pointer"
      },
      field: { display: "flex", flexDirection: "column", gap: "4px" },
      input: {
        boxSizing: "border-box",
        width: "100%",
        padding: "6px 8px",
        border: "1px solid var(--dsw-alias-border-l1)",
        borderRadius: "8px",
        background: "var(--dsw-alias-bg-layer-1)",
        color: "var(--dsw-alias-label-primary)",
        fontSize: "13px"
      },
      dot: { width: "10px", height: "10px", borderRadius: "50%", flex: "none" },
      mono: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "11px", wordBreak: "break-all" }
    }

    /** 一行「状态点 + 说明」。 */
    function StatusLine(props) {
      return h(
        "div",
        { style: styles.row },
        h("span", { style: Object.assign({}, styles.dot, { background: props.ok ? "var(--dsw-alias-state-success-primary)" : "var(--dsw-alias-state-error-primary)" }) }),
        h("span", { style: Object.assign({}, styles.value, { flex: 1 }) }, props.text)
      )
    }

    /**
     * Cookie 保活的状态文案。
     *
     * 保活的必要性：新版 Chrome/Edge 的 Google 会话启用了设备绑定会话（DBSC），
     * 登录态由 __Secure-1PSIDTS 承载，而这张票只有持有设备密钥的浏览器能换发；
     * 内核手里的快照换发不了，票一过期就会被当成未登录。
     */
    function describeKeepAlive(data) {
      var ka = data && data.keepAlive
      if (!ka) return "Cookie 保活：状态未知"
      if (ka.enabled === false) return "Cookie 保活已关闭：Google 换发登录票后内核会掉登录（需重新登录）"
      var parts = [(ka.running ? "Cookie 保活运行中" : "Cookie 保活待命") + " · 每 " + ka.intervalMinutes + " 分钟检查 · 已回写 " + (ka.pushes || 0) + " 次"]
      if (ka.lastPushAt) parts.push("最近回写 " + new Date(ka.lastPushAt).toLocaleTimeString())
      if (ka.lastError) parts.push(ka.lastError)
      return parts.join(" · ")
    }

    /** 保活状态是否算健康。 */
    function keepAliveOk(data) {
      var ka = data && data.keepAlive
      if (!ka) return false
      if (ka.enabled === false) return false
      return ka.lastError === "" || ka.lastError === undefined
    }

    /** 主设置卡片。 */
    function GeminiWebSettings(props) {
      var scope = props.scope
      var config = useConfig(scope)
      var status = useStatus(3000)
      var local = react.useState({ busy: "", message: "", error: "" })
      var busy = local[0].busy
      var message = local[0].message
      var error = local[0].error
      var setLocal = local[1]

      /** 执行一个会改后端状态的动作，并把结果写进提示行。 */
      function run(key, fn, describe) {
        setLocal({ busy: key, message: "", error: "" })
        Promise.resolve()
          .then(fn)
          .then(function (result) {
            // 后端返回 {ok:false,message} 也算失败，直接显示它的说明。
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
        return h("div", { style: styles.card }, h("p", { style: styles.hint }, "Gemini 网页端设置加载中…"))
      }

      var value = config.value || {}
      var data = status.value.data
      var login = data ? data.login : undefined
      var kernel = data ? data.kernel : undefined
      var loggedIn = login && login.phase === "ok"
      var awaiting = login && login.phase === "awaiting-confirm"
      var reading = login && login.phase === "reading"

      return h(
        "div",
        { style: styles.card },

        // 状态
        h(
          "div",
          { style: styles.row },
          h(StatusLine, {
            ok: !!(data && data.kernel && data.kernel.running),
            text: data
              ? (data.kernel && data.kernel.running
                ? "反代内核运行中 · 端口 " + data.port + " · 模型 " + (data.kernel.models || []).length + " 个 · Cookie " + (data.kernel.enabled || 0) + "/" + (data.kernel.cookies || 0)
                : (data.kernelExists ? "反代内核未运行" : "尚未下载反代内核"))
              : (status.value.loading ? "读取状态…" : "无法读取状态：" + (status.value.error || "未知错误"))
          })
        ),
        h(StatusLine, {
          ok: loggedIn,
          text: login ? login.message : "登录状态未知"
        }),
        h(StatusLine, {
          ok: keepAliveOk(data),
          text: describeKeepAlive(data)
        }),

        // 按钮
        h(
          "div",
          { style: styles.row },
          h(
            "button",
            {
              type: "button",
              style: styles.primary,
              disabled: busy !== "" || reading,
              onClick: function () {
                run("login", function () { return call("/login", "POST", {}) }, function () { return "已打开浏览器窗口，登录完成后点「我已完成登录」" })
              }
            },
            awaiting ? "重新打开登录窗口" : "登录 Google"
          ),
          h(
            "button",
            {
              type: "button",
              style: styles.primary,
              disabled: busy !== "" || !awaiting,
              onClick: function () {
                run("confirm", function () { return call("/login/confirm", "POST", {}) }, function (r) { return (r && r.message) || "已读取 cookie" })
              }
            },
            busy === "confirm" ? "读取 cookie…" : "我已完成登录"
          ),
          h(
            "button",
            {
              type: "button",
              style: styles.button,
              disabled: busy !== "" || !awaiting,
              onClick: function () { run("cancel", function () { return call("/login/cancel", "POST", {}) }, function () { return "已取消登录" }) }
            },
            "取消"
          ),
          h(
            "button",
            {
              type: "button",
              style: styles.button,
              disabled: busy !== "",
              onClick: function () {
                var box = typeof document === "undefined" ? null : document.getElementById("dsh-gemini-web-killfirst")
                var killFirst = !!(box && box.checked)
                run("import", function () { return call("/import/system", "POST", { killFirst: killFirst }) }, function (r) { return (r && r.message) || "已导入系统浏览器的登录态" })
              }
            },
            busy === "import" ? "导入中…" : "导入系统浏览器登录态"
          ),
          h(
            "label",
            { style: Object.assign({}, styles.row, { gap: "6px" }) },
            h("input", { type: "checkbox", id: "dsh-gemini-web-killfirst" }),
            h("span", { style: styles.hint }, "导入前先自动关闭浏览器")
          ),
          h(
            "button",
            {
              type: "button",
              style: styles.button,
              disabled: busy !== "",
              onClick: function () { run("logout", function () { return call("/logout", "POST", {}) }, function () { return "已退出登录并清空 Cookie 池" }) }
            },
            "退出登录"
          ),
          h(
            "button",
            {
              type: "button",
              style: styles.button,
              disabled: busy !== "",
              onClick: function () { run("keepalive", function () { return call("/keepalive/now", "POST", {}) }, function (r) { return (r && r.message) || "已检查保活状态" }) }
            },
            busy === "keepalive" ? "保活中…" : "立即保活"
          ),
          h(
            "button",
            {
              type: "button",
              style: styles.button,
              disabled: busy !== "",
              onClick: function () { run("restart", function () { return call("/kernel/restart", "POST", {}) }, function (r) { return "内核已重启，模型 " + ((r && r.models) || []).length + " 个" }) }
            },
            busy === "restart" ? "重启中…" : "重启内核"
          ),
          h(
            "button",
            {
              type: "button",
              style: styles.button,
              disabled: busy !== "",
              onClick: function () { run("install", function () { return call("/kernel/install", "POST", {}) }, function (r) { return "内核已下载（" + Math.round(((r && r.bytes) || 0) / 1048576) + " MB）" }) }
            },
            busy === "install" ? "下载中…" : "下载 / 更新内核"
          ),
          h(
            "button",
            {
              type: "button",
              style: styles.button,
              disabled: busy !== "",
              onClick: function () { run("test", function () { return call("/test", "POST", {}) }, function (r) { return r && r.ok ? "连通性正常" : "连通性失败：" + ((r && (r.detail || r.error)) || "未知原因") }) }
            },
            busy === "test" ? "测试中…" : "连通性测试"
          )
        ),

        message ? h("p", { style: Object.assign({}, styles.hint, { color: "var(--dsw-alias-state-success-primary)" }) }, message) : null,
        error ? h("p", { style: Object.assign({}, styles.hint, { color: "var(--dsw-alias-state-error-primary)" }) }, error) : null,

        // 配置
        h("label", { style: styles.row },
          h("input", { type: "checkbox", checked: value.enabled !== false, disabled: !config.writable, onChange: setField("enabled") }),
          h("span", { style: styles.value }, "启用 Gemini 网页端 provider")
        ),

        h("label", { style: styles.row },
          h("input", { type: "checkbox", checked: value.keepAliveEnabled !== false, disabled: !config.writable, onChange: setField("keepAliveEnabled") }),
          h("span", { style: styles.value }, "自动保活 cookie（常驻无窗口浏览器，维持 Google 设备绑定会话的登录票轮转）")
        ),
        h("div", { style: styles.field },
          h("span", { style: styles.label }, "保活检查间隔（分钟，1–120）"),
          h("input", { type: "number", style: styles.input, defaultValue: String(value.keepAliveIntervalMinutes ?? 5), disabled: !config.writable, onBlur: setField("keepAliveIntervalMinutes") })
        ),

        h("div", { style: styles.field },
          h("span", { style: styles.label }, "出口代理（内核访问 Google 用，留空则沿用 DSH 进程的 HTTPS_PROXY）"),
          h("input", { type: "text", style: styles.input, defaultValue: value.proxyUrl || "", disabled: !config.writable, placeholder: "http://127.0.0.1:7897", onBlur: setField("proxyUrl") })
        ),
        h("div", { style: styles.field },
          h("span", { style: styles.label }, "浏览器路径（留空自动探测 Chrome / Edge）"),
          h("input", { type: "text", style: styles.input, defaultValue: value.browserPath || "", disabled: !config.writable, placeholder: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", onBlur: setField("browserPath") })
        ),
        h("div", { style: styles.field },
          h("span", { style: styles.label }, "反代内核路径（留空用 ~/.dsh/gemini-web/bin/ 下的自动路径）"),
          h("input", { type: "text", style: styles.input, defaultValue: value.kernelPath || "", disabled: !config.writable, onBlur: setField("kernelPath") })
        ),
        h("div", { style: styles.field },
          h("span", { style: styles.label }, "内核端口（0 = 自动选择）"),
          h("input", { type: "number", style: styles.input, defaultValue: String(value.port ?? 0), disabled: !config.writable, onBlur: setField("port") })
        ),

        data && data.baseUrl ? h("p", { style: Object.assign({}, styles.hint, styles.mono) }, "Base URL：" + data.baseUrl) : null,
        data && data.kernel && (data.kernel.models || []).length > 0
          ? h("p", { style: styles.hint }, "当前模型：" + data.kernel.models.join("、"))
          : null,
        data && data.kernel && data.kernel.account
          ? h("p", { style: styles.hint }, "内核登录账号 #" + data.kernel.account.id + " · " + (data.kernel.account.health === "ok" ? "登录态正常" : "健康度 " + data.kernel.account.health) + (data.kernel.account.hasPsidts === true ? " · 含 __Secure-1PSIDTS" : " · 缺 __Secure-1PSIDTS（需重新登录）"))
          : null,
        h(
          "p",
          { style: styles.hint },
          "网页端模型没有真正的 function calling（上游是 prompt 级实现），工具调用不如原生 provider 稳，建议作为问答/生图线路使用。"
        )
      )
    }

    /**
     * 浏览器插件入口。
     * @param ctx - 客户端 cordis 上下文。
     */
    function apply(ctx) {
      var scope = ctx.settingsScope.bind({ namespace: "gemini-web" })
      ctx.slots.inject("settings.plugin.item", function () {
        return ctx.slots.register(
          { name: "settings.plugin.item", key: "gemini-web" },
          function GeminiWebCard() {
            return h(GeminiWebSettings, { scope: scope })
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
