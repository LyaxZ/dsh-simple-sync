window.__ModuleLoader__.load({
  id: "dsh-simple-sync",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var React = require("react");
    var jsx = require("react/jsx-runtime").jsx;
    require("@deepseek-ai/dsh-client-runtime/client");

    // ---------- i18n (component-local; nav label uses the locale service) ----------
    var DICT = {
      zh: {
        nav: "同步",
        backend: "传输后端",
        hintPrefix: "说明",
        test: "测试连接",
        push: "立即推送",
        preview: "查看差异",
        apply: "拉取并应用",
        optAuto: "启动 DSH 时自动检测远端",
        optCred: "同步凭据（.credentials.yaml）",
        status: "状态",
        machine: "本机",
        lastPush: "上次推送",
        lastPull: "上次拉取",
        never: "从未",
        syncRoot: "数据目录",
        actions: "操作",
        busy: "处理中…",
        fieldRepo: "仓库地址",
        fieldToken: "令牌",
        fieldProxy: "代理",
        fieldBranch: "分支",
        fieldDir: "文件夹路径",
        tokenSaved: "已保存（留空保持不变）",
        tokenEmpty: "留空则用系统凭据 / SSH",
        refresh: "重新加载",
      },
      en: {
        nav: "Sync",
        backend: "Backend",
        hintPrefix: "Notes",
        test: "Test connection",
        push: "Push now",
        preview: "Preview diff",
        apply: "Pull & apply",
        optAuto: "Auto-check remote on DSH startup",
        optCred: "Sync credentials (.credentials.yaml)",
        status: "Status",
        machine: "Machine",
        lastPush: "Last push",
        lastPull: "Last pull",
        never: "never",
        syncRoot: "Data dir",
        actions: "Actions",
        busy: "Working…",
        fieldRepo: "Repository URL",
        fieldToken: "Token",
        fieldProxy: "Proxy",
        fieldBranch: "Branch",
        fieldDir: "Folder path",
        tokenSaved: "saved (leave blank to keep)",
        tokenEmpty: "blank = system credentials / SSH",
        refresh: "Reload",
      },
    };
    var NS = "dsh-simple-sync";
    function L(key) {
      var lang = typeof navigator !== "undefined" && navigator.language && navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
      return (DICT[lang] && DICT[lang][key]) || DICT.zh[key] || key;
    }

    // ---------- remote descriptors ----------
    // The client-side gateway ($mount) REQUIRES strict codecs, and at call
    // time only ever touches `codec.schema.parse(value)` — so a pass-through
    // parse schema satisfies the contract without shipping a zod runtime.
    // Wire format stays plain JSON (same contract as the host's src-json).
    function strictCodec(typeSymbol) {
      return Object.freeze({
        mode: "strict",
        typeSymbol: typeSymbol,
        schema: Object.freeze({ parse: function (v) { return v; } }),
      });
    }

    function strictDescriptor(method, parameters, cancellation) {
      var typeSymbol = "dsh-simple-sync#json";
      return Object.freeze({
        id: "dsh-simple-sync#syncPanel/" + method,
        service: "syncPanel",
        namespace: "syncPanel",
        method: method,
        invocation: Object.freeze({ kind: "direct" }),
        parameters: Object.freeze(parameters.map(function (p) {
          return Object.freeze({ name: p, wire: p, source: "json", codec: strictCodec(typeSymbol) });
        })),
        ...(cancellation ? { cancellation: Object.freeze({ parameter: "signal" }) } : {}),
        result: strictCodec(typeSymbol),
      });
    }

    var SYNC_REMOTE = Object.freeze({
      package: "dsh-simple-sync",
      descriptors: Object.freeze([
        strictDescriptor("status", []),
        strictDescriptor("saveConfig", ["config"]),
        strictDescriptor("test", [], true),
        strictDescriptor("push", [], true),
        strictDescriptor("preview", [], true),
        strictDescriptor("apply", [], true),
      ]),
    });

    function unwrap(result) {
      if (!result || !result.ok) {
        var err = result && result.error;
        var detail = "";
        if (err) {
          detail = (err.code || "?") + ": " + (err.message || "");
          if (err.details && Object.keys(err.details).length) detail += " " + JSON.stringify(err.details);
        } else {
          detail = "空响应";
        }
        throw new Error(detail);
      }
      return result.value;
    }

    // ---------- styles ----------
    var S = {
      wrap: { padding: "4px 2px", fontSize: 13, lineHeight: 1.55 },
      section: { marginBottom: 14 },
      title: { fontSize: 13, fontWeight: 600, margin: "0 0 8px", opacity: 0.9 },
      row: { marginBottom: 8, display: "flex", alignItems: "center", gap: 8 },
      label: { width: 96, flex: "0 0 96px", opacity: 0.75 },
      input: {
        flex: 1, minWidth: 0, padding: "5px 8px", fontSize: 13,
        background: "transparent", color: "inherit",
        border: "1px solid rgba(128,128,128,0.35)", borderRadius: 6, outline: "none",
      },
      select: { padding: "5px 8px", fontSize: 13, background: "transparent", color: "inherit", border: "1px solid rgba(128,128,128,0.35)", borderRadius: 6 },
      hint: { opacity: 0.6, fontSize: 12, margin: "2px 0 10px" },
      check: { display: "flex", alignItems: "center", gap: 6, marginBottom: 6, cursor: "pointer" },
      btn: {
        padding: "6px 14px", fontSize: 13, borderRadius: 6, cursor: "pointer",
        border: "1px solid rgba(128,128,128,0.4)", background: "transparent", color: "inherit",
      },
      btnPrimary: { borderColor: "rgba(90,140,255,0.7)" },
      btnRow: { display: "flex", gap: 8, flexWrap: "wrap" },
      block: {
        marginTop: 10, padding: "8px 10px", borderRadius: 6, fontSize: 12.5,
        border: "1px solid rgba(128,128,128,0.3)", whiteSpace: "pre-wrap",
        wordBreak: "break-all", fontFamily: "ui-monospace, monospace",
      },
      err: { borderColor: "rgba(230,90,90,0.6)", color: "#e88585" },
      ok: { borderColor: "rgba(90,180,120,0.5)", color: "#8fcf9f" },
      muted: { opacity: 0.65, fontSize: 12, margin: "2px 0" },
    };

    // ---------- panel component ----------
    function SyncSection(props) {
      var panel = props.panel;
      var useState = React.useState;
      var useEffect = React.useEffect;

      var [status, setStatus] = useState(null);
      var [form, setForm] = useState(null);
      var [busy, setBusy] = useState(null);
      var [result, setResult] = useState(null);

      function refresh() {
        setResult(null);
        var attempts = 0;
        function tryOnce() {
          attempts += 1;
          panel.status().then(function (s) {
            setStatus(s);
            setForm({
              backend: s.state.backend,
              git: { repo: s.state.git.repo, token: "", proxy: s.state.git.proxy, branch: s.state.git.branch },
              local: { dir: s.state.local.dir },
              includeCredentials: s.state.includeCredentials,
              autoCheck: s.state.autoCheck,
            });
          }).catch(function (e) {
            // transient failures (DSH restart / reconnect window) retry with backoff
            if (attempts < 3) {
              setTimeout(tryOnce, 800 * attempts);
            } else {
              setResult({ kind: "err", text: String((e && e.message) || e) });
            }
          });
        }
        tryOnce();
      }

      useEffect(function () { refresh(); }, []);

      function updateSection(sectionKey, value) {
        setForm(Object.assign({}, form, { [sectionKey]: value }));
      }
      function updateField(key, value) {
        var nested = form.backend === "local" ? Object.assign({}, form.local, { [key]: value }) : Object.assign({}, form.git, { [key]: value });
        setForm(Object.assign({}, form, form.backend === "local" ? { local: nested } : { git: nested }));
      }

      function run(action) {
        setBusy(action);
        setResult(null);
        panel.saveConfig(form).then(function () {
          if (action === "test") return panel.test();
          if (action === "push") return panel.push();
          if (action === "preview") return panel.preview();
          return panel.apply();
        }).then(function (r) {
          setResult({ kind: r.ok ? "ok" : "err", text: r.message || "" });
          if (action === "push" || action === "apply") {
            panel.status().then(setStatus).catch(function () {});
          }
        }).catch(function (e) {
          setResult({ kind: "err", text: String((e && e.message) || e) });
        }).finally(function () {
          setBusy(null);
        });
      }

      if (!form) return jsx("div", { style: S.muted, children: L("busy") });

      var meta = null;
      if (status && status.backends) {
        for (var i = 0; i < status.backends.length; i += 1) {
          if (status.backends[i].id === form.backend) { meta = status.backends[i]; break; }
        }
      }
      var st = status ? status.state : null;

      var fields = [];
      if (meta) {
        for (var j = 0; j < meta.fields.length; j += 1) {
          var f = meta.fields[j];
          var val = form.backend === "local" ? (form.local[f.key] || "") : (form.git[f.key] || "");
          var ph = "";
          if (f.key === "token") ph = st && st.git.tokenSet ? L("tokenSaved") : L("tokenEmpty");
          fields.push(jsx("div", {
            key: f.key, style: S.row,
            children: [
              jsx("span", { style: S.label, children: L("field" + f.key.charAt(0).toUpperCase() + f.key.slice(1)) }),
              jsx("input", {
                style: S.input,
                type: f.key === "token" ? "password" : "text",
                value: val,
                placeholder: ph,
                disabled: busy !== null,
                onChange: function (ev) { updateField(f.key, ev.target.value); },
              }),
            ],
          }));
        }
      }

      var stateLines = [];
      if (st) {
        stateLines.push(L("machine") + ": " + status.machine);
        stateLines.push(L("backend") + ": " + (meta ? meta.label : form.backend));
        stateLines.push(L("lastPush") + ": " + (st.lastPush || L("never")) + (st.lastPushMachine ? "（" + st.lastPushMachine + "）" : ""));
        stateLines.push(L("lastPull") + ": " + (st.lastPull || L("never")) + (st.lastPullMachine ? "（" + st.lastPullMachine + "）" : ""));
        if (st.lastError) stateLines.push("⚠️ " + st.lastError);
      }

      return jsx("div", {
        style: S.wrap,
        children: [
          jsx("div", {
            style: S.section,
            children: [
              jsx("div", { style: S.title, children: L("backend") }),
              jsx("div", {
                style: S.row,
                children: [
                  jsx("select", {
                    style: S.select,
                    value: form.backend,
                    disabled: busy !== null,
                    onChange: function (ev) { updateSection("backend", ev.target.value); },
                    children: status && status.backends ? status.backends.map(function (b) {
                      return jsx("option", { key: b.id, value: b.id, children: b.label });
                    }) : null,
                  }),
                ],
              }),
              meta ? jsx("div", { style: S.hint, children: L("hintPrefix") + ": " + meta.hint }) : null,
              fields,
              jsx("div", {
                style: S.check,
                children: [
                  jsx("input", { type: "checkbox", checked: form.autoCheck, disabled: busy !== null, onChange: function (ev) { updateSection("autoCheck", ev.target.checked); } }),
                  jsx("span", { children: L("optAuto") }),
                ],
              }),
              jsx("div", {
                style: S.check,
                children: [
                  jsx("input", { type: "checkbox", checked: form.includeCredentials, disabled: busy !== null, onChange: function (ev) { updateSection("includeCredentials", ev.target.checked); } }),
                  jsx("span", { children: L("optCred") }),
                ],
              }),
              jsx("div", {
                style: S.btnRow,
                children: [
                  jsx("button", { style: S.btn, disabled: busy !== null, onClick: function () { run("test"); }, children: busy === "test" ? L("busy") : L("test") }),
                  jsx("button", { style: S.btn, disabled: busy !== null, onClick: function () { run("preview"); }, children: busy === "preview" ? L("busy") : L("preview") }),
                  jsx("button", { style: Object.assign({}, S.btn, S.btnPrimary), disabled: busy !== null, onClick: function () { run("push"); }, children: busy === "push" ? L("busy") : L("push") }),
                  jsx("button", { style: Object.assign({}, S.btn, S.btnPrimary), disabled: busy !== null, onClick: function () { run("apply"); }, children: busy === "apply" ? L("busy") : L("apply") }),
                ],
              }),
            ],
          }),
          jsx("div", {
            style: S.section,
            children: [
              jsx("div", {
                style: S.title,
                children: [L("status"), jsx("span", {
                  style: { marginLeft: 8, fontSize: 11, opacity: 0.6, cursor: "pointer", textDecoration: "underline" },
                  onClick: refresh,
                  children: L("refresh"),
                })],
              }),
              stateLines.map(function (line, idx) {
                return jsx("div", { key: idx, style: S.muted, children: line });
              }),
            ],
          }),
          result ? jsx("div", {
            style: Object.assign({}, S.block, result.kind === "err" ? S.err : S.ok),
            children: result.text,
          }) : null,
        ],
      });
    }

    // ---------- plugin body ----------
    var inject = ["slots", "locale", "remote"];

    function apply(ctx) {
      ctx.effect(function () {
        return ctx.locale.register(NS, DICT);
      }, "dsh-simple-sync: dictionaries");

      ctx.effect(function () {
        var mounted = null;
        var pending = true;
        var unloaded = false;
        void (async function () {
          try {
            mounted = await ctx.remote.$mount(SYNC_REMOTE);
          } catch (error) {
            console.error("dsh-simple-sync: remote mount failed:", error);
          }
          pending = false;
          if (unloaded) void (mounted && mounted());
        })();
        return function () {
          unloaded = true;
          if (!pending) void (mounted && mounted());
        };
      }, "dsh-simple-sync: remote contribution");

      ctx.inject(["remote.syncPanel"], function (scope) {
        var t = scope.locale.bind(NS);
        var ns = function () { return scope.remote.syncPanel; };
        // NOTE: ns().<method>() returns a PROMISE of the {ok, value|error}
        // envelope — unwrap() must run on the resolved value (await), not on
        // the promise itself (dsh-backup: unwrap(await ns().status())).
        var panel = {
          status: function () { return ns().status().then(unwrap); },
          saveConfig: function (c) { return ns().saveConfig(c).then(unwrap); },
          test: function () { return ns().test().then(unwrap); },
          push: function () { return ns().push().then(unwrap); },
          preview: function () { return ns().preview().then(unwrap); },
          apply: function () { return ns().apply().then(unwrap); },
        };
        scope.slots.inject("settings.section", function () {
          return scope.slots.register({
            name: "settings.section",
            id: "simple-sync",
            order: 240,
            label: function () { return t("nav"); },
            locale: NS,
            inject: function () { return { panel: panel }; },
          }, SyncSection);
        });
      });
    }

    exports.apply = apply;
    exports.inject = inject;

    return module.exports;
  }
});
