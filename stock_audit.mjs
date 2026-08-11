// 审计 / 运行时指标 / 系统设置 / 数据库备份（P2-2 从 stock_engine.mjs 抽出）
// 依赖：db（ESM live binding from stock_engine）、computeAllPositionsFromEvents（同上）。
// 循环依赖安全：本模块顶层只有函数定义，不立即调用 db。
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, readdirSync, unlinkSync, statSync, existsSync, copyFileSync, renameSync } from "node:fs";
import { join, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { db, DB_PATH, computeAllPositionsFromEvents } from "./stock_engine.mjs";

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const BACKUP_DIR = join(__dirname, "backups");

let lastBackupVerification = { status: 'unverified', file: null, checkedAt: null, error: null };

// ----- 信号审计 -----
export function recordStockSignalAudit(rec, marketState = 'closed') {
  if (!rec?.symbol || !rec?.final_action) return null;
  const ts = Number(rec.ts) || Date.now(), minuteKey = new Date(ts).toISOString().slice(0, 16), symbol = String(rec.symbol).toUpperCase();
  db.prepare(`INSERT INTO stock_signal_audit(symbol,market,minute_key,ts,price,raw_action,final_action,action_label,confidence,actionable,market_state,reason,signal_date)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(symbol,minute_key) DO UPDATE SET ts=excluded.ts,price=excluded.price,raw_action=excluded.raw_action,
    final_action=excluded.final_action,action_label=excluded.action_label,confidence=excluded.confidence,actionable=excluded.actionable,
    market_state=excluded.market_state,reason=excluded.reason,signal_date=excluded.signal_date`)
    .run(symbol, String(rec.market || 'US').toUpperCase(), minuteKey, ts, rec.price ?? null, rec.raw_action || null, rec.final_action,
      rec.action_label || null, rec.confidence ?? null, rec.actionable ? 1 : 0, String(marketState || 'closed'), rec.reason || null, rec.signal_date || null);
  const audit = db.prepare("SELECT * FROM stock_signal_audit WHERE symbol=? AND minute_key=?").get(symbol, minuteKey);
  return audit;
}

export function getStockSignalAudit(symbol, limit = 200) {
  const n = Math.min(2000, Math.max(1, Math.round(Number(limit) || 200))), sym = String(symbol || '').toUpperCase();
  if (sym) return db.prepare("SELECT * FROM stock_signal_audit WHERE symbol=? ORDER BY ts DESC LIMIT ?").all(sym, n);
  return db.prepare("SELECT * FROM stock_signal_audit ORDER BY ts DESC LIMIT ?").all(n);
}

// ----- 提醒审计 -----
export function recordAlertAudit(row = {}) {
  const ts = Number(row.ts) || Date.now(), key = String(row.event_key || [ts, row.type, row.symbol_code || row.symbol || '', row.pair_id || '', row.channel || '', row.signal || ''].join('|'));
  db.prepare(`INSERT OR IGNORE INTO alert_audit(event_key,ts,type,symbol_code,pair_id,channel,signal,detail,market_state,status,error) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
    .run(key, ts, String(row.type || ''), String(row.symbol_code || row.symbol || '').toUpperCase() || null, Number(row.pair_id) || null, row.channel || null, row.signal || null, row.detail || null, row.market_state || null, row.status || 'logged', row.error || null);
  return db.prepare("SELECT * FROM alert_audit WHERE event_key=?").get(key);
}

export function updateAlertAudit(eventKey, status, error = null) {
  db.prepare("UPDATE alert_audit SET status=?,error=? WHERE event_key=?").run(status, error, eventKey);
}

export function getAlertAudit({ type = '', symbol = '', pairId = 0, limit = 200 } = {}) {
  const where = [], params = [];
  if (type) { where.push('type=?'); params.push(type); }
  if (symbol) { where.push('symbol_code=?'); params.push(String(symbol).toUpperCase()); }
  if (Number(pairId) > 0) { where.push('pair_id=?'); params.push(Number(pairId)); }
  params.push(Math.min(2000, Math.max(1, Number(limit) || 200)));
  return db.prepare(`SELECT * FROM alert_audit ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ts DESC LIMIT ?`).all(...params);
}

// ----- 运行时指标 -----
export function recordRuntimeMetric(row = {}) {
  const endpoint = String(row.endpoint || '').slice(0, 120);
  if (!endpoint) return;
  db.prepare('INSERT INTO runtime_metrics(ts,endpoint,duration_ms,status_code,detail) VALUES(?,?,?,?,?)')
    .run(Number(row.ts) || Date.now(), endpoint, Math.max(0, Math.round(Number(row.durationMs) || 0)), Number(row.statusCode) || null, row.detail ? String(row.detail).slice(0, 300) : null);
  if (Math.random() < 0.01) db.prepare('DELETE FROM runtime_metrics WHERE ts < ?').run(Date.now() - 14 * 86400000);
}

export function getRuntimeMetrics({ hours = 24, limit = 10000 } = {}) {
  const since = Date.now() - Math.max(1, Math.min(24 * 30, Number(hours) || 24)) * 3600000;
  const rows = db.prepare('SELECT endpoint,duration_ms,status_code,ts FROM runtime_metrics WHERE ts>=? ORDER BY ts DESC LIMIT ?')
    .all(since, Math.min(20000, Math.max(1, Number(limit) || 10000)));
  const byEndpoint = new Map();
  for (const row of rows) {
    const list = byEndpoint.get(row.endpoint) || []; list.push(row); byEndpoint.set(row.endpoint, list);
  }
  const endpoints = [...byEndpoint.entries()].map(([endpoint, list]) => {
    const durations = list.map(row => Number(row.duration_ms) || 0).sort((a, b) => a - b);
    const p95 = durations[Math.min(durations.length - 1, Math.floor((durations.length - 1) * .95))] || 0;
    const failed = list.filter(row => Number(row.status_code) >= 400).length;
    return { endpoint, count: list.length, avgMs: Math.round(durations.reduce((sum, n) => sum + n, 0) / durations.length), p95Ms: p95, maxMs: durations.at(-1) || 0, failed, lastTs: Math.max(...list.map(row => Number(row.ts) || 0)) };
  }).sort((a, b) => b.p95Ms - a.p95Ms);
  return { since, samples: rows.length, endpoints };
}

// ----- 系统设置 -----
export function getSystemSetting(key, fallback = null) {
  const row = db.prepare("SELECT value_json,updated_at FROM system_settings WHERE key=?").get(String(key || ''));
  if (!row) return { value: fallback, updated_at: null };
  try { return { value: JSON.parse(row.value_json), updated_at: row.updated_at }; } catch { return { value: fallback, updated_at: row.updated_at }; }
}

export function setSystemSetting(key, value) {
  const updatedAt = Date.now();
  db.prepare(`INSERT INTO system_settings(key,value_json,updated_at) VALUES(?,?,?)
    ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`)
    .run(String(key || ''), JSON.stringify(value ?? null), updatedAt);
  return { value, updated_at: updatedAt };
}

// ----- 工具 -----
export function transitionsOnly(rows, field = 'final_action') {
  return rows.filter((r, i) => i === rows.length - 1 || r[field] !== rows[i + 1]?.[field]);
}

export function getStockPositions() {
  return computeAllPositionsFromEvents();
}

// ----- 数据库备份 -----
export function backupFiles() {
  try { mkdirSync(BACKUP_DIR, { recursive: true }); return readdirSync(BACKUP_DIR).filter(x => /^market-dashboard-.*\.db$/.test(x)).sort().reverse(); } catch { return []; }
}

export async function verifyDatabaseBackup(file = null) {
  const selected = file || backupFiles()[0] || null;
  if (!selected) { return lastBackupVerification = { status: 'missing', file: null, checkedAt: Date.now(), error: 'no backup file' }; }
  const target = join(BACKUP_DIR, selected);
  try {
    // 把全库 verification 放在子进程里跑，避免阻塞 HTTP。
    const script = "const Database=require('better-sqlite3');const db=new Database(process.argv[1],{readonly:true,fileMustExist:true});const result=db.pragma('quick_check',{simple:true});db.close();process.stdout.write(String(result));";
    const { stdout } = await execFileAsync(process.execPath, ['-e', script, target], { cwd: __dirname, timeout: 120000, windowsHide: true });
    const integrity = String(stdout || '').trim();
    lastBackupVerification = { status: String(integrity).toLowerCase() === 'ok' ? 'verified' : 'invalid', file: selected, checkedAt: Date.now(), error: String(integrity).toLowerCase() === 'ok' ? null : String(integrity) };
  } catch (error) { lastBackupVerification = { status: 'invalid', file: selected, checkedAt: Date.now(), error: String(error?.message || error) }; }
  return lastBackupVerification;
}

export function getBackupStatus() {
  const files = backupFiles(), latest = files[0] || null; let modifiedAt = null;
  try { if (latest) modifiedAt = statSync(join(BACKUP_DIR, latest)).mtimeMs; } catch {}
  return { count: files.length, latest, directory: BACKUP_DIR, modifiedAt, verification: lastBackupVerification.file === latest ? lastBackupVerification : { status: 'unverified', file: latest, checkedAt: null, error: null } };
}

export async function createDatabaseBackup(reason = 'manual') {
  mkdirSync(BACKUP_DIR, { recursive: true });
  const now = new Date(), stamp = now.toISOString().replace(/[:.]/g, '-'), day = stamp.slice(0, 10);
  if (reason === 'auto') {
    const existing = backupFiles().find(x => x.startsWith('market-dashboard-' + day) && x.endsWith('-auto.db'));
    if (existing) {
      pruneOldBackups();
      return { ok: true, skipped: true, file: existing, verification: await verifyDatabaseBackup(existing), ...getBackupStatus() };
    }
  }
  const file = `market-dashboard-${stamp}-${String(reason).replace(/[^a-z0-9_-]/gi, '') || 'manual'}.db`, target = join(BACKUP_DIR, file);
  await db.backup(target);
  pruneOldBackups();
  return { ok: true, file, verification: await verifyDatabaseBackup(file), ...getBackupStatus() };
}

// 保留最近 7 个备份，删除更早的。auto skip 路径也调用，避免旧备份累积。
function pruneOldBackups() {
  const files = backupFiles();
  for (const old of files.slice(7)) try { unlinkSync(join(BACKUP_DIR, old)); } catch {}
}

// ----- 数据库恢复（P0）-----
// 恢复流程：
//  - dryRun=true：仅对备份文件做 PRAGMA quick_check + schema 校验（与生产 DB 表清单对比），不替换生产 DB
//  - dryRun=false：关闭当前连接 → 重命名生产 DB 为 .pre-restore-{ts} → 复制备份到生产 DB 路径 →
//                  重新打开连接 → 跑 quick_check → process.exit(0) 让进程管理器重启，避免 prepared statement 失效
// 任何步骤失败都尝试回滚（恢复 .pre-restore 文件），返回 { ok:false, error }
function resolveBackupPath(backupPath) {
  if (!backupPath || typeof backupPath !== 'string') return null;
  // 接受绝对路径或相对项目根的相对路径；纯文件名则默认在 backups/ 下
  let p = backupPath;
  if (!isAbsolute(p)) {
    const candidate = join(__dirname, p);
    p = existsSync(candidate) ? candidate : join(BACKUP_DIR, p);
  }
  if (!p.endsWith('.db') || !existsSync(p)) return null;
  return p;
}

function listTables(sqliteDb) {
  return sqliteDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r => r.name);
}

function quickCheck(sqliteDb) {
  const result = sqliteDb.pragma('quick_check', { simple: true });
  return String(result || '').toLowerCase() === 'ok';
}

export function restoreDatabaseBackup({ backupPath, dryRun = false } = {}) {
  const resolved = resolveBackupPath(backupPath);
  if (!resolved) return { ok: false, error: 'backupPath 不存在或不是 .db 文件' };

  // 1. dryRun：只做校验，不动生产 DB
  if (dryRun) {
    let backupDb = null;
    try {
      // 注意：WAL 模式数据库在 readonly 下会因 -wal 文件无法创建而报 "attempt to write a readonly database"，
      // 所以这里不用 readonly。quick_check + SELECT 都是只读操作，不会修改 .db 文件本身。
      backupDb = new Database(resolved, { fileMustExist: true });
      const schemaOk = quickCheck(backupDb);
      const backupTables = listTables(backupDb);
      // 与生产 DB 表清单对比
      let prodTables = [];
      try { prodTables = listTables(db); } catch { prodTables = []; }
      const prodSet = new Set(prodTables), backupSet = new Set(backupTables);
      const missingTables = prodTables.filter(t => !backupSet.has(t)); // 生产有但备份没有
      const extraTables = backupTables.filter(t => !prodSet.has(t)); // 备份有但生产没有
      // ok = dryRun 本身成功（文件是合法 SQLite 且 quick_check 通过）；missingTables/extraTables 是漂移信息
      return {
        ok: schemaOk,
        dryRun: true,
        schemaCheck: schemaOk,
        tableCount: backupTables.length,
        missingTables,
        extraTables,
      };
    } catch (error) {
      return { ok: false, dryRun: true, schemaCheck: false, error: String(error?.message || error) };
    } finally {
      try { backupDb?.close(); } catch {}
      // 清理 backup 打开时可能产生的 -wal/-shm 旁车文件（只清备份目录下的，不动生产）
      try {
        const walPath = resolved + '-wal', shmPath = resolved + '-shm';
        if (existsSync(walPath)) unlinkSync(walPath);
        if (existsSync(shmPath)) unlinkSync(shmPath);
      } catch {}
    }
  }

  // 2. 实际恢复
  let previousSize = 0, restoredSize = 0;
  let renamedPrevPath = null;
  let dbClosed = false;
  try {
    // 先对备份文件做 quick_check，避免用损坏的备份覆盖生产
    let preCheckDb = null;
    try {
      preCheckDb = new Database(resolved, { fileMustExist: true });
      if (!quickCheck(preCheckDb)) {
        preCheckDb.close();
        return { ok: false, error: '备份文件 PRAGMA quick_check 未通过，已中止恢复' };
      }
      preCheckDb.close();
    } catch (error) {
      try { preCheckDb?.close(); } catch {}
      return { ok: false, error: `备份文件预校验失败：${error?.message || error}` };
    } finally {
      try {
        const walPath = resolved + '-wal', shmPath = resolved + '-shm';
        if (existsSync(walPath)) unlinkSync(walPath);
        if (existsSync(shmPath)) unlinkSync(shmPath);
      } catch {}
    }

    // 记录原 DB 文件大小
    try { previousSize = statSync(DB_PATH).size; } catch {}

    // 关闭当前连接
    try { db.close(); } catch {}
    dbClosed = true;

    // 重命名生产 DB 为 .pre-restore-{ts}（保留作为安全网）
    const ts = Date.now();
    renamedPrevPath = `${DB_PATH}.pre-restore-${ts}`;
    renameSync(DB_PATH, renamedPrevPath);

    // 复制备份到生产 DB 路径
    copyFileSync(resolved, DB_PATH);
    try { restoredSize = statSync(DB_PATH).size; } catch {}

    // 重新打开连接并验证
    const newDb = new Database(DB_PATH);
    newDb.pragma('journal_mode = WAL');
    newDb.pragma('busy_timeout = 5000');
    const schemaOk = quickCheck(newDb);
    newDb.close();

    if (!schemaOk) {
      // 恢复后完整性校验失败，回滚
      try { unlinkSync(DB_PATH); } catch {}
      try { renameSync(renamedPrevPath, DB_PATH); } catch {}
      return { ok: false, error: '恢复后 PRAGMA quick_check 未通过，已回滚' };
    }

    // 关键：better-sqlite3 的 prepared statement 绑定到具体 Database 实例。
    // 即使重新赋值 db 变量，其他模块（tracker_engine / alert_engine 等）持有的 prepared statements
    // 也会失效。最安全可靠的方式：process.exit(0) 让 PM2/start.bat 自动重启，所有模块重新初始化。
    // 给响应一点时间写出，再退出
    const result = {
      ok: true,
      restoredAt: new Date().toISOString(),
      previousSize,
      restoredSize,
      schemaCheck: schemaOk,
      preRestoreFile: renamedPrevPath,
      note: '进程即将退出（process.exit 0），由进程管理器自动重启',
    };
    setTimeout(() => { try { process.exit(0); } catch {} }, 300);
    return result;
  } catch (error) {
    // 任何步骤失败 → 尝试回滚
    try {
      if (dbClosed && renamedPrevPath && existsSync(renamedPrevPath)) {
        if (existsSync(DB_PATH)) try { unlinkSync(DB_PATH); } catch {}
        try { renameSync(renamedPrevPath, DB_PATH); } catch {}
      }
    } catch {}
    return { ok: false, error: String(error?.message || error), previousSize, restoredSize };
  }
}
