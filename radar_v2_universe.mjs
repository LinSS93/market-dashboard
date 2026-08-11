// 机会雷达 v2 全市场宇宙加载。
//
// 数据源：radar_universe_members 表（24007 行，CN/HK/US 三市场）。
// 本模块只读，不创建表，复用 radar_v2_schema 的 DB 连接。
//
// 过滤规则：
//   - 只取 active=1 的活跃标的（active=0 为 excluded_product 衍生品等）
//   - 只取 instrument_type='equity'（ETF 在其他层处理）
//   - 动态发现各市场的 enabled universe（不硬编码 universe_id）
//     生产库中 HK=1, US=193, CN=194，各市场 universe_id 不同

import { getRadarV2Db } from './radar_v2_schema.mjs';

const MARKETS = ['US', 'HK', 'CN'];

// 上游 US universe 偶尔把 Warrant / Right / Unit / Note / ETF 标成 instrument_type='equity'。
// 它们不是本产品的普通股研究对象，必须在唯一的 universe 入口剔除，避免
// scanner、趋势状态机和回放验收得到彼此不一致的候选池。
//
// P0 重构（针对曾漏过的 ONEQ/ROBT/SPBC/TSPY/XSPI/BBB 等）：
//   名称正则不是可靠证券分类。queue 查询改为：
//     1. 优先读 radar_v2_asset_audit.asset_category（人工或脚本审计的结果）
//     2. 无审计记录时回到 instrument_type + 名称正则兜底
//        - 名称明确命中非普通股关键词 → 'non_common'
//        - instrument_type='equity' 且名称无嫌疑 → 'common_provisional'（暂进队列，UI 标待审计）
//   本模块只负责名称正则兜底分类。审计表读写见 radar_v2_query_api.setAssetAudit。
//
// 名称字段常被截断到 ~30 字符，"ETF" 后缀可能丢失，因此同时识别：
//   - 后缀关键词（WARRANT/NOTES/ETF/ETN/PFD/PRF/UNIT/RIGHT）
//   - ETF 发行商前缀（iShares/Global X/SPDR/ProShares/Direxion/WisdomTree/VanEck/
//     Alpha Architect/Fidelity Disruptive/Invesco ... ETF|Trust/JPMorgan BetaBuilders/
//     VictoryShares/PIMCO StocksPlus）
//   - ETF/基金常见后缀词（TRUST/FUND/INDEX 系列），仅在与发行商前缀同时出现时判定
const NON_COMMON_EQUITY_NAME = /\b(?:WARRANTS?|WT\.?|RIGHTS?|RTS?\.?|UNITS?|NOTES?|ETFS?|ETNS?|PFD\.?|PRF\.?)\b/i;
const ETF_ISSUER_NAME = /(?:^|\b)(?:iShares|Global\s+X|SPDR|ProShares|Direxion|WisdomTree|VanEck|Alpha\s+Architect|Fidelity\s+Disruptive|Invesco\s+\w+\s+(?:ETF|Trust)|JPMorgan\s+BetaBuilders|VictoryShares|PIMCO\s+StocksPlus)\b/i;
// 名称以 "XSPI" 类四字母大写 + 含特定基金后缀时也判为非普通股。
// 这些关键词与发行商前缀的组合误判风险极低。
const FUND_NAME_TAIL = /(?:^|\b)(?:TRUST|FUND|INDEX\s+(?:SERIES|FUND))\s*(?:SERIES)?\s*$/i;

/**
 * 名称正则兜底分类（仅当无 asset_audit 记录时使用）
 * @param {{name?: string, instrument_type?: string}} row
 * @returns {'common_provisional' | 'non_common'}
 *   - 'common_provisional'：名称无明显非普通股特征，暂时按普通股处理（UI 标"待审计"）
 *   - 'non_common'：名称命中非普通股关键词
 */
export function classifyByNameFallback(row) {
  const name = String(row?.name || '');
  if (NON_COMMON_EQUITY_NAME.test(name)) return 'non_common';
  if (ETF_ISSUER_NAME.test(name)) return 'non_common';
  if (FUND_NAME_TAIL.test(name) && /(?:FUND|TRUST|INDEX)/i.test(name)) return 'non_common';
  return 'common_provisional';
}

/**
 * 兼容旧调用方（loadUniverse 等仍用布尔返回值）
 * 名称正则兜底：true=无明确非普通股特征（含 'common_provisional'）；
 *              false=明确命中非普通股关键词。
 */
export function isEligibleCommonEquity(row) {
  return classifyByNameFallback(row) === 'common_provisional';
}

// 安全解析 metadata_json，失败或为空返回 null
function parseMetadata(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// 将原始行标准化为对外结构
function toMember(row) {
  return {
    market: row.market,
    symbol: row.symbol,
    name: row.name || null,
    metadata: parseMetadata(row.metadata_json),
  };
}

/**
 * 按市场获取所有 enabled universe 的 ID。
 * 一个市场可能有多个 provider 各自的 universe，全部启用则全部纳入。
 * @param {string} market - US/HK/CN
 * @returns {number[]} universe_id 数组，无匹配时为空数组
 */
export function getActiveUniverseIds(market) {
  const db = getRadarV2Db();
  const rows = db
    .prepare('SELECT id FROM radar_universes WHERE market = ? AND enabled = 1 ORDER BY id')
    .all(market);
  return rows.map(r => r.id);
}

/**
 * 加载活跃股票宇宙。
 * 动态发现各市场的 enabled universe，不再硬编码 universe_id。
 * @param {string|null} market - 可选市场过滤（US/HK/CN），null 表示三市场全量
 * @returns {Array<{market, symbol, name, metadata}>}
 */
export function loadUniverse(market = null) {
  const db = getRadarV2Db();
  const targets = market ? [market] : MARKETS;
  const members = [];
  for (const m of targets) {
    const ids = getActiveUniverseIds(m);
    if (ids.length === 0) continue;
    const placeholders = ids.map(() => '?').join(',');
    const rows = db
      .prepare(`
        SELECT market, symbol, name, metadata_json
        FROM radar_universe_members
        WHERE universe_id IN (${placeholders})
          AND market = ?
          AND active = 1
          AND instrument_type = 'equity'
        GROUP BY symbol
        ORDER BY symbol ASC
      `)
      .all(...ids, m);
    members.push(...rows.filter(isEligibleCommonEquity).map(toMember));
  }
  return members;
}

/**
 * 按市场分组返回宇宙。
 * @returns {{US: Array, HK: Array, CN: Array}}
 */
export function loadUniverseByMarket() {
  const grouped = { US: [], HK: [], CN: [] };
  for (const m of MARKETS) {
    grouped[m] = loadUniverse(m);
  }
  return grouped;
}

/**
 * 返回各市场活跃股票数量统计。
 * @returns {{US: number, HK: number, CN: number, total: number}}
 */
export function getUniverseStats() {
  const db = getRadarV2Db();
  const stats = { US: 0, HK: 0, CN: 0, total: 0 };
  for (const m of MARKETS) {
    const ids = getActiveUniverseIds(m);
    if (ids.length === 0) continue;
    const placeholders = ids.map(() => '?').join(',');
    const row = db
      .prepare(`
        SELECT COUNT(DISTINCT symbol) AS cnt
        FROM radar_universe_members
        WHERE universe_id IN (${placeholders})
          AND market = ?
          AND active = 1
          AND instrument_type = 'equity'
      `)
      .get(...ids, m);
    const cnt = row?.cnt || 0;
    stats[m] = cnt;
    stats.total += cnt;
  }
  return stats;
}

/**
 * 扫描用宇宙，支持 limit 与采样。
 * @param {string} market - 必填，US/HK/CN
 * @param {{limit?: number, sampling?: number, seed?: number}} [options]
 *   - limit: 最多返回条数
 *   - sampling: 采样比例 (0,1]，1 表示全量；<1 时按比例抽取
 *   - seed: 采样种子，结合 symbol hash 做确定性抽样，保证跨次扫描可复现
 * @returns {Array<{market, symbol, name, metadata}>}
 */
export function getUniverseForScan(market, options = {}) {
  const full = loadUniverse(market);
  const { limit, sampling = 1, seed = 0 } = options;
  let result = full;
  if (sampling < 1 && sampling > 0) {
    // 确定性采样：symbol hash + seed 取模，跨次扫描结果稳定
    result = full.filter((m) => {
      let h = seed;
      for (let i = 0; i < m.symbol.length; i++) {
        h = (h * 31 + m.symbol.charCodeAt(i)) & 0x7fffffff;
      }
      return (h % 1000) / 1000 < sampling;
    });
  }
  if (limit && Number.isFinite(limit) && limit > 0) {
    result = result.slice(0, limit);
  }
  return result;
}
