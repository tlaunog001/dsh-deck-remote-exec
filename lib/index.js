// dsh-deck-remote-exec — 让 dsh-mattpocock-skills-deck 在远端 workspace 里正常工作。
//
// 三个职责，都不改 dsh-remote 的源码：
//
//   1. 提供 ctx.remoteFs   —— 让 deck 读到远端真实工作区，而不是本地镜像
//   2. 提供 ctx.remoteExec —— 让 deck 的 gh/git 探测在远端执行
//   3. 把 deck 的 fs / subprocess / resolveExecutable 接到上面两个服务
//
// 为什么是「启动时改目标包」而不是直接 ctx.provide 覆盖：
//   deck 内部用 ctx.get("fs") / ctx.get("subprocess") 拿的是核心单例，
//   外部插件无法替换（cordis 的 provide 不覆盖已注册服务）。
//   所以只能把「取服务」的那几个函数改道 —— 见 patchSource()。
//
// ponytail: 改的是构建产物，目标包升级会覆盖；本插件每次启动重新检查，能自愈。
//   上游若原生支持远端服务，本插件可整体删除。

import { readFileSync, writeFileSync, copyFileSync, existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { loadRemoteModules, createServices } from "./services.js";

export const name = "dsh-deck-remote-exec";
export const inject = [];

const TARGET_PKG = "dsh-mattpocock-skills-deck";

// 我们写入的签名（用于幂等判断）
const SIGN = "dsh-deck-remote-exec";
const SIGN_FS = "__rdeFsFacade";
const SIGN_EXEC = "__rdeExecFor";
const SIGN_RESOLVE = "__rdeResolve";

function log(ctx, level, msg) {
  try {
    const lc = ctx && typeof ctx.get === "function" ? ctx.get("logCtx") : null;
    if (lc && typeof lc.fire === "function") { lc.fire(level, SIGN, { msg }); return; }
  } catch {}
  try { process.stderr.write("[" + SIGN + "] " + level + ": " + msg + "\n"); } catch {}
}

function locatTargets() {
  // 插件可能装在与目标包不同的目录（本机就是：插件在 ~/.dsh/deck-patch-bug-004，
  // deck 在 profiles/<profile>/node_modules），所以不能只靠 require.resolve。
  const req = createRequire(import.meta.url);
  const candidates = [];
  try { candidates.push(path.dirname(req.resolve(TARGET_PKG + "/package.json"))); } catch {}
  try {
    // issue #3：URL.pathname 在 win32 上给出带前导斜杠的 /C:/…，path.join 之后变成
    //   \C:\…，existsSync 恒 false —— 这条候选在 Windows 上其实是死代码。
    //   用 fileURLToPath 解码，macOS/POSIX 行为不变。
    const here = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
    candidates.push(path.join(path.dirname(here), TARGET_PKG));
  } catch {}
  try {
    const dshHome = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
    const prof = process.env.DSH_PROFILE || "desktop";
    candidates.push(path.join(dshHome, "profiles", prof, "node_modules", TARGET_PKG));
  } catch {}
  let root = null;
  for (const c of candidates) { if (c && existsSync(path.join(c, "package.json"))) { root = c; break; } }
  if (!root) return null;
  return {
    index: path.join(root, "lib", "index.js"),
    platform: path.join(root, "lib", "platform", "index.js"),
    predicate: path.join(root, "lib", "tracker", "predicatePrimitives.js"),
  };
}

/** 给 deck 的 platform.resolveExecutable 加「远端优先」。 */
export function patchPlatform(src) {
  if (typeof src !== "string") return src;
  if (src.includes(SIGN_RESOLVE)) return src;
  // 不管原签名有没有 opts，统一替换成 (name, opts) —— 否则函数体里用 opts 会 ReferenceError。
  const CANON = "  const resolveExecutable = async (name, opts) => {";
  const variants = [
    "  const resolveExecutable = async (name, opts) => {",
    "  const resolveExecutable = async (name) => {",
  ];
  const head = variants.find((v) => src.includes(v));
  if (!head) return src;
  const BLOCK = [
      CANON,
    "    // " + SIGN + "：platform 是全局单例、ctx 无 cwd，cwd 只能由调用方经 opts 传进来。",
    "    const __rdeResolve = (cwd) => {",
    "      if (typeof cwd !== \"string\" || !cwd) return null;",
    "      try {",
    "        const svc = typeof ctx.get === \"function\" ? ctx.get(\"remoteExec\") : undefined;",
    "        if (!svc || typeof svc.resolveExecutable !== \"function\" || typeof svc.isRemotePath !== \"function\") return null;",
    "        return svc.isRemotePath(cwd) ? svc : null;",
    "      } catch { return null; }",
    "    };",
    "    const __rdeRx = __rdeResolve(opts && opts.cwd);",
    "    if (__rdeRx) {",
    "      try { return (await __rdeRx.resolveExecutable(name, { cwd: opts.cwd })) || null; } catch { return null; }",
    "    }",
  ].join("\n");
  return src.replace(head, BLOCK);
}

/** 给 deck 的 predicatePrimitives 补 cwd（面板 gh:installed 的数据源）。 */
export function patchPredicate(src) {
  if (typeof src !== "string") return src;
  if (src.includes("__rdePcCwd")) return src;
  const OLD = "      const hit = await p.resolveExecutable(cmd);";
  if (!src.includes(OLD)) return src;
  const NEW = [
    "      const __rdePcCwd = ctx && typeof ctx.cwd === \"string\" ? ctx.cwd : \"\";",
    "      const hit = await p.resolveExecutable(cmd, { cwd: __rdePcCwd });",
  ].join("\n");
  return src.replace(OLD, NEW);
}

/** 给 deck 的 apply(ctx) 入口注入服务解析 + 三处改道。 */
export function patchSource(src) {
  if (typeof src !== "string") return src;
  if (src.includes(SIGN_FS) && src.includes(SIGN_EXEC) && src.includes(SIGN_RESOLVE)) return src;

  // 锚点：原版 apply(ctx) 的开头。插件在这之后注入服务解析 + fs 代理。
  const CTX_ANCHOR = "  apply(ctx) {";
  if (!src.includes(CTX_ANCHOR)) return src;

  let out = src;

  // 1) 服务解析 + fs 代理：接在 ctx 重绑定之后
  if (!out.includes(SIGN_FS)) {
    const block = [
      "    // ── " + SIGN + " ─────────────────────────────────────────",
      "    // 远端服务由本插件注册；未安装 dsh-remote 时为 null，全部回退本地。",
      "    // 原 fs 必须先取到并缓存：下面 ctx.get(\"fs\") 会返回本代理自身，",
      "    // 每次调用都去取会无限递归（踩过这个坑）。",
      "    const __rdeLocalFs = ctx.get(\"fs\");",
      "    let __rdeSvcCache;",
      "    const __rdeSvc = () => {",
      "      if (__rdeSvcCache !== void 0) return __rdeSvcCache;",
      "      try {",
      "        const s = typeof ctx.get === \"function\" ? ctx.get(\"remoteFs\") : null;",
      "        const x = typeof ctx.get === \"function\" ? ctx.get(\"remoteExec\") : null;",
      "        __rdeSvcCache = s && s.fs ? { fs: s.fs, exec: x || null } : null;",
      "      } catch { __rdeSvcCache = null; }",
      "      return __rdeSvcCache;",
      "    };",
      "    // 只对「落在远端镜像里的路径」改道；其余交回原 fs。",
      "    const __rdeFsFacade = new Proxy({}, {",
      "      get(_, prop) {",
      "        const s = __rdeSvc();",
      "        const actual = __rdeLocalFs;",
      "        if (s && s.fs) {",
      "          const f = s.fs[prop];",
      "          if (typeof f === \"function\") {",
      "            return async (...a) => {",
      "              try { const r = await f.apply(s.fs, a); if (r !== null && r !== void 0) return r; } catch (e) {",
      "                if (e && e.code === \"FS_SANDBOX_DENIED\") throw e;",
      "              }",
      "              const g = actual && actual[prop];",
      "              return typeof g === \"function\" ? g.apply(actual, a) : void 0;",
      "            };",
      "          }",
      "        }",
      "        const g = actual && actual[prop];",
      "        return typeof g === \"function\" ? g.bind(actual) : g;",
      "      },",
      "      has(_, prop) { const actual = __rdeLocalFs; return !!(actual && prop in actual); },",
      "    });",
      "    // 把 ctx.get('fs') 接到代理：deck 内部用 ctx.get('fs') 取 fs，",
      "    // 不换掉这一层，代理永远不会被用到。",
      "    const __rdeBaseGet = ctx.get.bind(ctx);",
      "    // deck 的 git-execution.js 直接拿 deps.subprocess 执行 git，",
      "    // 不经过 deck 自己的 execProc。不拦这一层，仓库识别就永远走宿主。",
      "    const __rdeSubprocess = (real) => {",
      "      if (!real || typeof real.spawn !== \"function\") return real;",
      "      return new Proxy(real, {",
      "        get(t2, prop) {",
      "          if (prop === \"spawn\") {",
      "            return function (spec) {",
      "              const s = __rdeSvc();",
      "              const cwd = (spec && spec.cwd) || \"\";",
      "              const argv = spec && spec.argv;",
      "              if (!s || !s.exec || !Array.isArray(argv) || !argv.length) return t2.spawn(spec);",
      "              let remote = false;",
      "              try { remote = typeof s.exec.isRemotePath === \"function\" && s.exec.isRemotePath(cwd); } catch { remote = false; }",
      "              if (!remote) return t2.spawn(spec);",
      "              let outText = \"\", errText = \"\", done = false;",
      "              const sink = (buf) => ({ readFrom() { return { text: buf }; }, text: buf });",
      "              const collected = { stdout: sink(\"\"), stderr: sink(\"\") };",
      "              const promise = s.exec.exec(argv[0], argv.slice(1), { cwd, timeout: (spec && spec.timeoutMs) || 30000 })",
      "                .then((r) => { outText = String((r && r.stdout) || \"\"); errText = String((r && r.stderr) || \"\"); done = true; collected.stdout = sink(outText); collected.stderr = sink(errText); return { exitCode: (r && typeof r.code === \"number\") ? r.code : -1, signal: null }; })",
      "                .catch((e) => { errText = String((e && e.message) || e); done = true; collected.stderr = sink(errText); return { exitCode: -1, signal: null }; });",
      "              return { done: promise, collected, stdin: { write() {}, end() {} }, terminate() {} };",
      "            };",
      "          }",
      "          const v = t2[prop];",
      "          return typeof v === \"function\" ? v.bind(t2) : v;",
      "        },",
      "      });",
      "    };",
      "    ctx = new Proxy(ctx, {",
      "      get(t, prop) {",
      "        if (prop === \"get\") {",
      "          return function (n, ...rest) {",
      "            if (n === \"fs\") return __rdeFsFacade;",
      "            if (n === \"subprocess\") return __rdeSubprocess(__rdeBaseGet(n, ...rest));",
      "            return __rdeBaseGet(n, ...rest);",
      "          };",
      "        }",
      "        const v = t[prop];",
      "        return typeof v === \"function\" ? v.bind(t) : v;",
      "      },",
      "    });",
    ].join("\n");
    out = out.replace(CTX_ANCHOR, CTX_ANCHOR + "\n" + block);
  }

  // 2) exec 改道：detectionExec / execProc 在远端镜像里改走 remoteExec
  // BUG-006：__rdeExecFor 必须定义在 apply(ctx) 作用域，两个函数共用。
  //   原来拼进 detectionExec 函数体，execProc 引用时够不着作用域，
  //   抛 "__rdeExecFor is not defined"（errorHash 70d48f26），
  //   wf.initPublish 的预检第一步就走 execProc，导致「创建并发布」稳定 internal 失败。
  if (!out.includes(SIGN_EXEC)) {
    const RX = [
      "      // BUG-006：apply 作用域，detectionExec / execProc 共用。",
      "      const __rdeExecFor = (cwd) => {",
      "        const s = __rdeSvc();",
      "        if (!s || !s.exec || typeof s.exec.isRemotePath !== \"function\") return null;",
      "        if (typeof cwd !== \"string\" || !cwd) return null;",
      "        try { return s.exec.isRemotePath(cwd) ? s.exec : null; } catch { return null; }",
      "      };",
    ].join("\n");
    // detectionExec：helper 放在函数声明「之前」= apply 作用域，不再塞进函数体
    const DE = "      async function detectionExec(...args) {";
    if (out.includes(DE)) out = out.replace(DE, RX + "\n" + DE + "\n" + [
      "      const __rdeDeCwd = (args[2] && args[2].cwd) || (ctx && ctx.cwd) || \"\";",
      "      const __rdeDeSvc = __rdeExecFor(__rdeDeCwd);",
      "      if (__rdeDeSvc) {",
      "        try {",
      "          const rr = await __rdeDeSvc.exec(args[0], args[1] || [], { cwd: __rdeDeCwd, timeout: args[2] && args[2].timeout, signal: args[2] && args[2].signal });",
      "          return { stdout: rr.stdout || \"\", stderr: rr.stderr || \"\", code: typeof rr.code === \"number\" ? rr.code : -1 };",
      "        } catch (e) { return { stdout: \"\", stderr: String((e && e.message) || e), code: -1 }; }",
      "      }",
    ].join("\n"));
    // execProc
    const EP = "      async function execProc(...args) {";
    if (out.includes(EP)) out = out.replace(EP, EP + "\n" + [
      "      const __rdeEpArgv = Array.isArray(args[0]) ? args[0] : null;",
      "      const __rdeEpCwd = typeof args[1] === \"string\" ? args[1] : (ctx && ctx.cwd) || \"\";",
      "      const __rdeEpSvc = __rdeExecFor(__rdeEpCwd);",
      "      if (__rdeEpSvc && __rdeEpArgv && __rdeEpArgv.length) {",
      "        try {",
      "          const rr = await __rdeEpSvc.exec(__rdeEpArgv[0], __rdeEpArgv.slice(1), { cwd: __rdeEpCwd });",
      "          const ok = rr.code === 0;",
      "          return { ok, code: rr.code, text: rr.stdout || \"\", error: ok ? \"\" : String(rr.stderr || rr.stdout || \"exit \" + rr.code).slice(0, 400) };",
      "        } catch (e) { return { ok: false, code: -1, text: \"\", error: String((e && e.message) || e).slice(0, 400) }; }",
      "      }",
    ].join("\n"));
  }

  return out;
}

export async function apply(ctx, config = {}) {
  // ① 先注册两个服务（本插件自己就是提供方，不依赖 dsh-remote 已被打过补丁）
  let svc = null;
  try {
    const mods = await loadRemoteModules();
    if (mods) {
      svc = await createServices(mods);
      if (svc) {
        try { ctx.provide("remoteFs", svc.fsService); } catch (e) { log(ctx, "warn", "provide remoteFs 失败：" + String((e && e.message) || e)); }
        try { ctx.provide("remoteExec", svc.execService); } catch (e) { log(ctx, "warn", "provide remoteExec 失败：" + String((e && e.message) || e)); }
        // 自检：能认出已存在的镜像才算真正可用（否则注册了也是空壳）
        try {
          const root = mods && mods.root;
          const probe = svc.fsService.isRemotePath;
          const dshHome = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
          const wsRoot = path.join(dshHome, "remote-workspaces");
          let mirrors = [];
          try {
            for (const h of readdirSync(wsRoot)) {
              try { for (const n of readdirSync(path.join(wsRoot, h), { withFileTypes: true })) { if (n.isDirectory()) mirrors.push(path.join(wsRoot, h, n.name)); } } catch {}
            }
          } catch (eEnum) {
            log(ctx, "warn", "列镜像失败 wsRoot=" + wsRoot + "：" + String((eEnum && eEnum.message) || eEnum));
          }
          const okCount = mirrors.filter((m) => { try { return probe(m) === true; } catch { return false; } }).length;
          log(ctx, "info", "已注册 remoteFs / remoteExec | 镜像 " + mirrors.length + " 个，识别通过 " + okCount + " 个");
          if (mirrors.length > 0 && okCount === 0) log(ctx, "error", "镜像识别全部失败：远端服务不可用，deck 将回落本地");
        } catch (e) {
          log(ctx, "warn", "自检失败：" + String((e && e.message) || e));
        }
      }
    } else {
      log(ctx, "info", "未安装 dsh-remote，远端服务不可用（deck 将按本地工作）");
    }
  } catch (e) {
    log(ctx, "warn", "注册远端服务失败：" + String((e && e.message) || e));
  }

  if (svc && typeof ctx.effect === "function") {
    try { ctx.effect(() => () => { try { svc.dispose(); } catch {} }, SIGN + ".services"); } catch {}
  }

  // ② 再改 deck 的取服务函数
  const targets = locatTargets();
  if (!targets) { log(ctx, "info", "未安装 " + TARGET_PKG + "，跳过"); return; }

  // issue #4：改道只在启动打一次不够——目标包在运行中被热升级后三处签名会被新产物覆盖，
  //   而 apply() 不会重跑，远端路由静默退化成宿主本地，症状重新伪装成 issue #1 那套。
  //   把「打一遍并如实汇报」抽成可复用动作：启动打一次，之后远端调用前做存在性自检，缺了就重打。
  const SELF_HEAL_MIN_INTERVAL_MS = 5000;
  let _lastSelfHeal = 0;

  function patchOne(file, fn, label, signList) {
    if (!existsSync(file)) return { label, outcome: "missing" };
    let src;
    try { src = readFileSync(file, "utf8"); } catch (e) { return { label, outcome: "read-failed", detail: String((e && e.message) || e) }; }
    // 已经是远端版本：什么都不做，且这不是失败。
    if (signList.every((x) => src.includes(x))) return { label, outcome: "already" };
    const next = fn(src);
    // 关键区分（issue #4）：patch 返回原串有两种可能——已打过（上面已排除）或锚点失配。
    //   旧实现把两者都记成 info「保持不动」，于是锚点漂移会静默失效，用户只看到 #1 那套症状。
    if (next === src) return { label, outcome: "skipped", detail: "锚点不匹配：目标产物结构变了，本次没有改道成功" };
    try { copyFileSync(file, file + ".dsh-deck-remote-exec.bak"); } catch (e) { log(ctx, "warn", label + " 备份失败：" + String((e && e.message) || e)); }
    try { writeFileSync(file, next, "utf8"); return { label, outcome: "applied" }; } catch (e) { return { label, outcome: "write-failed", detail: String((e && e.message) || e) }; }
  }

  function applyPatchSet() {
    const t = locatTargets();
    if (!t) { log(ctx, "warn", "没定位到目标包 " + TARGET_PKG + "，改道未执行"); return []; }
    const results = [
      patchOne(t.index, patchSource, "index.js", [SIGN_FS, SIGN_EXEC, SIGN_RESOLVE]),
      patchOne(t.platform, patchPlatform, "platform/index.js", [SIGN_RESOLVE]),
      patchOne(t.predicate, patchPredicate, "predicatePrimitives.js", ["__rdePcCwd"]),
    ];
    // 固定打一行汇总，排查时一眼看出这次到底打没打上（issue #4 第 3 点建议）。
    const summary = results.map((r) => r.label + "=" + r.outcome + (r.detail ? "(" + r.detail + ")" : "")).join(" ");
    const bad = results.filter((r) => r.outcome === "skipped" || r.outcome === "read-failed" || r.outcome === "write-failed" || r.outcome === "missing");
    if (bad.length) log(ctx, "warn", "本次对 deck 的三处改道结果：" + summary);
    else log(ctx, "info", "本次对 deck 的三处改道结果：" + summary);
    return results;
  }

  applyPatchSet();

  // 自检入口：远端调用前用。距上次检查不足 5 秒直接返回；只在真有缺失时才重打并出声。
  function ensurePatched() {
    const now = Date.now();
    if (now - _lastSelfHeal < SELF_HEAL_MIN_INTERVAL_MS) return;
    _lastSelfHeal = now;
    try {
      const t = locatTargets();
      if (!t) return;
      const need = [
        { file: t.index, signs: [SIGN_FS, SIGN_EXEC, SIGN_RESOLVE] },
        { file: t.platform, signs: [SIGN_RESOLVE] },
        { file: t.predicate, signs: ["__rdePcCwd"] },
      ].some((one) => { try { const src = readFileSync(one.file, "utf8"); return !one.signs.every((x) => src.includes(x)); } catch { return false; } });
      if (!need) return;
      log(ctx, "warn", "检测到 deck 产物已被替换（改道签名缺失），正在重打 —— 通常是目标包刚热升级过");
      applyPatchSet();
    } catch {}
  }

  // 定时自检：目标包被热升级后（插件管理器允许运行中安装/更新），这个定时器能在一个周期内
  //   把三处改道补回来，不依赖 deck 侧调用（services.js 拿不到本插件的闭包）。
  //   检查本身只 readFileSync 三个文件查签名，且有 5 秒节流；正常情况不写盘、不打日志。
  try {
    const timer = setInterval(() => { try { ensurePatched(); } catch {} }, 30000);
    if (timer && typeof timer.unref === "function") timer.unref();
    if (typeof ctx.effect === "function") ctx.effect(() => () => { try { clearInterval(timer); } catch {} }, SIGN + ".selfheal");
  } catch {}
}