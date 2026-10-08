// ── dsh-usage-lite · Host half ──────────────────────────────────────────────
// 跨全部会话聚合 provider 上报的 token 用量，并以 HTTP 路由供给 Web 设置页：
//
//   GET /usage-lite/stats   全量聚合快照（含按天、按模型、按工作区、会话数）
//   GET /usage-lite/health  探活
//
// 数据源：ctx.sessionQuery（live 优先、持久化兜底），只折叠
// assistant/message 事件上 source.kind === "model" 的 usage 样本；
// inheritedEventCount 之前的事件属于父会话（fork/resume 继承），跳过以免重复计数。
//
// 增量索引：以持久化日志 mtime 为变更信号（live 会话每次都重读），
// 快照持久化到 ~/.dsh/usage-lite/index.json。
// 请求路径非阻塞：/stats 立即返回内存快照，变更检测在后台进行（stale-while-revalidate）。
// 本文件是纯 Node ESM，无构建步骤，不依赖第三方包。
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";

export const name = "dsh-usage-lite";

export const inject = ["webServer", "sessionQuery"];

const ROUTE_PREFIX = "/usage-lite";
const INDEX_VERSION = 1;
const SCAN_TTL_MS = 4000;           // 两次全量扫描（列表 + mtime 比对）之间的最小间隔
const PERSIST_MIN_INTERVAL = 10000; // 索引落盘节流

const emptyTotals = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, calls: 0 });

function addUsage(target, usage) {
  target.input += usage.inputTokens ?? 0;
  target.output += usage.outputTokens ?? 0;
  target.cacheRead += usage.cacheReadTokens ?? 0;
  target.cacheWrite += usage.cacheWriteTokens ?? 0;
  target.reasoning += usage.reasoningTokens ?? 0;
  target.calls += 1;
}

function sumInto(target, source) {
  target.input += source.input;
  target.output += source.output;
  target.cacheRead += source.cacheRead;
  target.cacheWrite += source.cacheWrite;
  target.reasoning += source.reasoning;
  target.calls += source.calls;
}

function totalOf(t) {
  return t.input + t.output + t.cacheRead + t.cacheWrite;
}

/** 本地时区日键 YYYY-MM-DD（与浏览器 dayKey 一致）。 */
function dayKeyOf(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 抽取一个会话事件数组里的用量样本（跳过继承区间）。 */
function samplesOf(events, skipCount) {
  const samples = [];
  for (let i = skipCount; i < events.length; i++) {
    const event = events[i];
    if (event?.type !== "assistant/message") continue;
    const data = event.data;
    if (data === void 0 || data.usage === void 0) continue;
    const source = data.message?.source;
    if (source === void 0 || source.kind !== "model") continue;
    if (typeof source.provider !== "string" || typeof source.model !== "string") continue;
    samples.push({ time: event.time, provider: source.provider, model: source.model, usage: data.usage });
  }
  return samples;
}

/** 把一个会话的样本折叠成索引条目。 */
function foldSession(header, events, inheritedCount, mtimeMs) {
  // cells: Map<date, Map<"provider\0model", totals>> —— 按天×模型的最细粒度
  const cells = new Map();
  let firstAt;
  let lastAt;
  for (const sample of samplesOf(events, inheritedCount ?? 0)) {
    const date = dayKeyOf(sample.time);
    const key = `${sample.provider}\u0000${sample.model}`;
    let byModel = cells.get(date);
    if (byModel === void 0) {
      byModel = new Map();
      cells.set(date, byModel);
    }
    let cell = byModel.get(key);
    if (cell === void 0) {
      cell = emptyTotals();
      byModel.set(key, cell);
    }
    addUsage(cell, sample.usage);
    if (firstAt === void 0 || sample.time < firstAt) firstAt = sample.time;
    if (lastAt === void 0 || sample.time > lastAt) lastAt = sample.time;
  }
  return {
    mtimeMs: mtimeMs ?? null,
    createdAt: header.createdAt ?? null,
    cwd: header.cwd ?? null,
    depth: header.delegationDepth ?? 0,
    firstAt: firstAt ?? null,
    lastAt: lastAt ?? null,
    cells,
  };
}

// ── 索引快照持久化（版本化，缺文件/坏文件都从空开始，绝不抛出） ────────────────

function serializeEntries(entries, writtenAt) {
  const sessions = {};
  for (const [id, entry] of entries) {
    const cells = {};
    for (const [date, byModel] of entry.cells) {
      const models = {};
      for (const [key, cell] of byModel) models[key] = cell;
      cells[date] = models;
    }
    sessions[id] = {
      mtimeMs: entry.mtimeMs,
      createdAt: entry.createdAt,
      cwd: entry.cwd,
      depth: entry.depth,
      firstAt: entry.firstAt,
      lastAt: entry.lastAt,
      cells,
    };
  }
  return { version: INDEX_VERSION, writtenAt, sessions };
}

function parseIndexFile(text) {
  const raw = JSON.parse(text);
  if (raw?.version !== INDEX_VERSION) throw new Error(`index version mismatch: ${raw?.version}`);
  const entries = new Map();
  for (const [id, s] of Object.entries(raw.sessions ?? {})) {
    const cells = new Map();
    for (const [date, models] of Object.entries(s.cells ?? {})) {
      cells.set(date, new Map(Object.entries(models ?? {})));
    }
    entries.set(id, {
      mtimeMs: s.mtimeMs ?? null,
      createdAt: s.createdAt ?? null,
      cwd: s.cwd ?? null,
      depth: s.depth ?? 0,
      firstAt: s.firstAt ?? null,
      lastAt: s.lastAt ?? null,
      cells,
    });
  }
  return entries;
}

// ── 插件本体 ────────────────────────────────────────────────────────────────

export function apply(ctx) {
  const log = (level, message, error) => {
    const line = `[dsh-usage-lite] ${message}${error === void 0 ? "" : `: ${String(error?.stack ?? error)}`}`;
    try {
      if (level === "error") ctx.logger?.error?.(line);
      else ctx.logger?.warn?.(line);
    } catch {
      (level === "error" ? console.error : console.warn)(line);
    }
  };

  const sessionQuery = ctx.sessionQuery;
  const dshHomePath = ctx.get?.("dshHomePath");
  const indexDir = typeof dshHomePath === "function"
    ? dshHomePath("usage-lite")
    : join(homedir(), ".dsh", "usage-lite");
  const indexFile = join(indexDir, "index.json");

  /** sessionId → 折叠条目。 */
  const entries = new Map();
  let loaded = false;
  let scanning = null;
  let lastScanAt = 0;
  let dirty = false;
  let lastPersistAt = 0;
  let persistTimer = null;

  async function loadIndex() {
    try {
      const text = await readFile(indexFile, "utf8");
      for (const [id, entry] of parseIndexFile(text)) entries.set(id, entry);
    } catch (error) {
      if (error?.code !== "ENOENT") log("warn", "index snapshot unreadable, starting empty", error);
    }
    loaded = true;
  }

  async function persistNow() {
    dirty = false;
    lastPersistAt = Date.now();
    const payload = JSON.stringify(serializeEntries(entries, lastPersistAt));
    await mkdir(indexDir, { recursive: true });
    const tmp = `${indexFile}.tmp`;
    await writeFile(tmp, payload);
    await rename(tmp, indexFile);
  }

  function schedulePersist() {
    dirty = true;
    if (persistTimer !== null) return;
    const wait = Math.max(0, PERSIST_MIN_INTERVAL - (Date.now() - lastPersistAt));
    persistTimer = setTimeout(() => {
      persistTimer = null;
      if (!dirty) return;
      persistNow().catch((error) => log("warn", "index persist failed", error));
    }, wait);
    if (typeof persistTimer.unref === "function") persistTimer.unref();
  }

  async function mtimeOfPersisted(record) {
    try {
      const persistence = ctx.get?.("sessionPersistence");
      const location = persistence?.locate?.(record.header);
      if (location?.path === void 0) return void 0;
      const identity = await stat(location.path);
      return identity.mtimeMs;
    } catch {
      return void 0;
    }
  }

  /**
   * 增量对齐索引与当前会话清单：只重读新增/变更（live 会话每次都重读）。
   * 单飞行：并发请求共享同一次扫描。
   */
  function refresh(now = Date.now()) {
    if (scanning !== null) return scanning;
    if (loaded === false) return Promise.resolve();
    if (now - lastScanAt < SCAN_TTL_MS) return Promise.resolve();
    scanning = (async () => {
      const records = await sessionQuery.listSessions();
      const seen = new Set();
      for (const record of records) {
        const id = record.header.id;
        seen.add(id);
        const mtime = record.live ? now : await mtimeOfPersisted(record);
        const prev = entries.get(id);
        if (prev !== void 0 && !record.live && mtime !== void 0 && prev.mtimeMs === mtime) continue;
        try {
          const { events, inheritedEventCount } = await sessionQuery.readSession(id);
          entries.set(id, foldSession(record.header, events, inheritedEventCount, mtime));
          schedulePersist();
        } catch (error) {
          log("warn", `fold failed for session ${id}`, error);
        }
      }
      for (const id of [...entries.keys()]) {
        if (!seen.has(id)) {
          entries.delete(id);
          schedulePersist();
        }
      }
      lastScanAt = Date.now();
    })()
      .catch((error) => log("error", "index refresh failed", error))
      .finally(() => { scanning = null; });
    return scanning;
  }

  /** 由索引条目聚合成响应快照。 */
  function statsSnapshot() {
    const totals = emptyTotals();
    const byDay = new Map();     // date → totals
    const byModel = new Map();   // key → {provider, model, totals}
    const byWorkspace = new Map();
    const mergedCells = new Map(); // "date\u0000provider\u0000model" → totals
    let sessionsWithUsage = 0;
    let firstAt;
    let lastAt;
    for (const entry of entries.values()) {
      if (entry.cells.size === 0) continue;
      sessionsWithUsage += 1;
      const wsKey = entry.cwd ?? "(未知工作区)";
      let ws = byWorkspace.get(wsKey);
      if (ws === void 0) {
        const label = entry.cwd === void 0 || entry.cwd === null
          ? "(未知工作区)"
          : entry.cwd.split("/").filter(Boolean).pop() ?? entry.cwd;
        ws = { cwd: entry.cwd, label, sessions: 0, totals: emptyTotals() };
        byWorkspace.set(wsKey, ws);
      }
      ws.sessions += 1;
      for (const [date, byModelOfDay] of entry.cells) {
        if (entry.firstAt !== null && (firstAt === void 0 || entry.firstAt < firstAt)) firstAt = entry.firstAt;
        if (entry.lastAt !== null && (lastAt === void 0 || entry.lastAt > lastAt)) lastAt = entry.lastAt;
        for (const [key, cell] of byModelOfDay) {
          sumInto(totals, cell);
          let day = byDay.get(date);
          if (day === void 0) {
            day = emptyTotals();
            byDay.set(date, day);
          }
          sumInto(day, cell);
          let model = byModel.get(key);
          if (model === void 0) {
            const sep = key.indexOf("\u0000");
            model = { provider: key.slice(0, sep), model: key.slice(sep + 1), totals: emptyTotals() };
            byModel.set(key, model);
          }
          sumInto(model.totals, cell);
          sumInto(ws.totals, cell);
          const cellKey = `${date}\u0000${key}`;
          let merged = mergedCells.get(cellKey);
          if (merged === void 0) {
            merged = emptyTotals();
            mergedCells.set(cellKey, merged);
          }
          sumInto(merged, cell);
        }
      }
    }
    return {
      ok: true,
      generatedAt: Date.now(),
      totals: { ...totals, total: totalOf(totals) },
      sessions: entries.size,
      sessionsWithUsage,
      firstAt: firstAt ?? null,
      lastAt: lastAt ?? null,
      days: [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([date, cell]) => ({ date, ...cell, total: totalOf(cell) })),
      models: [...byModel.values()]
        .map((m) => ({ provider: m.provider, model: m.model, ...m.totals, total: totalOf(m.totals) }))
        .sort((a, b) => b.total - a.total),
      workspaces: [...byWorkspace.values()]
        .map((w) => ({ label: w.label, cwd: w.cwd, sessions: w.sessions, ...w.totals, total: totalOf(w.totals) }))
        .sort((a, b) => b.total - a.total),
      cells: [...mergedCells.entries()].map(([cellKey, cell]) => {
        const [date, provider, model] = cellKey.split("\u0000");
        return { date, provider, model, ...cell };
      }),
    };
  }

  const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

  async function statsHandler(req, res) {
    if (loaded === false) await loadIndex();
    // 秒开：立即返回内存中已聚合的快照，后台异步做变更检测（mtime 比对 +
    // 重读变更/live 会话），下一次请求即拿到新数据。仅首次安装索引为空时同步等待。
    if (entries.size === 0) await refresh(Date.now());
    else void refresh(Date.now());
    res.writeHead(200, JSON_HEADERS);
    res.end(JSON.stringify(statsSnapshot()));
  }

  ctx.effect(() => {
    // 装载：读快照并预热一次扫描，让首次打开页面就有数据。
    void loadIndex().then(() => refresh(Date.now()));
    return () => {
      if (persistTimer !== null) { clearTimeout(persistTimer); persistTimer = null; }
      if (dirty) void persistNow().catch(() => {});
    };
  }, "dsh-usage-lite: index lifecycle");

  ctx.effect(() => ctx.webServer.register({
    kind: "prefix",
    path: ROUTE_PREFIX,
    handler: async (req, res) => {
      const url = new URL(req.url ?? "/", "http://local");
      if (req.method === "GET" && url.pathname === `${ROUTE_PREFIX}/stats`) return statsHandler(req, res);
      if (req.method === "GET" && url.pathname === `${ROUTE_PREFIX}/health`) {
        res.writeHead(200, JSON_HEADERS);
        res.end(JSON.stringify({ ok: true, at: Date.now() }));
        return;
      }
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found");
    },
  }), "dsh-usage-lite: stats route");

  log("info", "host half loaded");
}
