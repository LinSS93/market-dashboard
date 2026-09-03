// 机会雷达 v2 资产分类规则引擎（审计修正 P1：自动分类替代人工逐只审计）。
//
// 三层规则，确定性依次递减：
//   CN  交易所代码段（A 股各板/基金段互不重叠）→ 确定性分类
//   HK  名称标记（轮证/基金/SPAC 关键词 + REIT 豁免）→ 剩余推定普通股
//   US  基金家族/结构词降级 + 其余推定普通股
//
// 与 autoAuditProvisionalAssets 的证据路径（Tier-1 官方披露 → common_stock）
// 配合：证据路径先行为有 SEC/HKEX/巨潮披露的标的定级；规则路径只处理
// 剩余 provisional/无记录标的。上市大盘公司几乎都有被捕获的披露记录，
// 因此家族词与上市公司同名的碰撞（Invesco Ltd/BlackRock Inc 等）已被
// 证据路径前置规避；规则降级永不覆盖人工审计（guarded upsert 语义）。
//
// 分类方向的风险不对称：
//   降级（etf/warrant/...）会把标的移出候选池 → 规则必须保守精确
//   升级（common_stock）只解除"待审计"标签与高置信限制 → 推定可接受
//   （误升级的 ETF 进入高置信仍需多通道信号，事件档案天然稀缺，暴露面小）
//
// 本模块零依赖（纯函数），供 radar_query_api 的自动审计调用。

// CN A 股股票板代码段（上交所主板/科创板 + 深交所主板/创业板）。
// ETF/LOF 段（沪 5xx、深 15x/16x/18x）与股票段无交集，交易所规则保证。
const CN_STOCK_PREFIXES = new Set([
  '600', '601', '603', '605', '688', '689',  // 上交所（688/689 科创板）
  '000', '001', '002', '003', '300', '301', '302',  // 深交所（300/301/302 创业板）
]);
// CN 基金/ETF 代码段：沪市 5 开头（510-518 ETF、50x LOF、56x、588）、
// 深市 15x ETF、16x/18x LOF/封基。北交所股票段（8x/43x/92x）不在两个
// 集合内 → 返回 null 保持 provisional（保守默认）。
const CN_FUND_PREFIX = /^(5\d{2}|1[5-9]\d)/;

// HK 名称标记（中文名为主；英文上市证券名同样适用）。
// 注意：JS 的 \b 基于 [A-Za-z0-9_]，中文是非 \w 字符，中英混排处不构成
// 词边界——中文关键词不能用 \b 限定，只有 ASCII 关键词（REIT/Acquisition）可以。
// 轮证检测：购/沽 可单字（轮证命名惯例"XX购/XX沽"）；牛/熊 必须组合出现
// （"牛证/熊证/牛熊"），避免误伤"多牛科技"这类公司名中的单字。
const HK_WARRANT_MARKER = /(购|沽|牛证|熊证|牛熊)/;
const HK_REIT_MARKER = /(产业|房产|房地产)|\bREITs?\b/i;       // 领展房产基金/置富产业信托等
const HK_FUND_MARKER = /(基金|ETF|指数|信托)/i;
const HK_FUND_MARKER_EN = /\b(ETF|Index Tracker|Tracker Fund|Fund)\b/i;
const HK_SPAC_MARKER = /(收购|\bAcquisition\b)/i;

// US 基金家族。两段策略：
//   安全品牌（无同名上市公司，任意位置匹配）
//   锚定品牌（^开头匹配；与上市公司同名，依赖证据路径前置定级规避碰撞）
const US_FUND_FAMILY_SAFE = /\b(?:iShares|Global\s+X|SPDR|ProShares|Direxion|WisdomTree|VanEck|Alpha\s+Architect|VictoryShares|PIMCO|Dimensional|First\s+Trust|PGIM|RiverNorth|Overlay\s+Shares|Motley\s+Fool|Innovator|GraniteShares|Simplify|Defiance|Roundhill|Amplify|Pacer|Tidal|KraneShares|X-?trackers|AdvisorShares|ALPS|Guggenheim|Nuveen|American\s+Century|Avantis|Bridgeway|Putnam|Oakmark|Polen|Thornburg|Wasatch|Yacktman|Calamos|Columbia\s+Threadneedle|Eventide|Eaton\s+Vance|Templeton|John\s+Hancock|Vanguard|Themes|Kurv|Strive|T-?Rex|Leverage\s+Shares|US\s+Benchmark|InfraCap)\b/i;
const US_FUND_FAMILY_ANCHORED = /^(?:Schwab|Fidelity|Invesco|BlackRock|Goldman\s+Sachs|Franklin|Morgan\s+Stanley|T\.\s?Rowe\s+Price|Hartford|Northern\s+Trust|Principal|BNY\s+Mellon|JPMorgan|Fidelity\s+Disruptive)\b/i;
// US 结构词：基金类名词出现在公司名中极罕见（\b 防止 Refund 之类误命中）
const US_FUND_STRUCTURAL = /\b(Fund|ETF|ETN|Portfolio)\b/i;
// US 非普通股证券词（映射到细分类目）
const US_WARRANT_WORD = /\b(WARRANTS?|WT\.?)\b/i;
const US_NOTE_WORD = /\b(NOTES?)\b/i;
const US_UNIT_WORD = /\b(UNITS?)\b/i;
const US_RIGHT_WORD = /\b(RIGHTS?|RTS?\.?)\b/i;
const US_PREFERRED_WORD = /\b(Series|Preferred|PFD\.?|PRF\.?)\b/i;

/**
 * 市场感知的资产分类规则。
 *
 * @param {string} market - US/HK/CN
 * @param {string} symbol - 证券代码
 * @param {string} name - 证券名称（universe 成员名）
 * @returns {{category: string, reason: string}|null}
 *   category ∈ common_stock | etf | warrant | note | unit | right | preferred | other_non_common
 *   null = 规则无法判定（保持 provisional，留给人工）
 */
export function classifyByMarketRules(market, symbol, name) {
  const sym = String(symbol || '').trim();
  const nm = String(name || '').trim();

  if (market === 'CN') {
    // 交易所代码段确定性分类；非 6 位数字（异常数据）不判定
    if (!/^\d{6}$/.test(sym)) return null;
    if (CN_STOCK_PREFIXES.has(sym.slice(0, 3))) {
      return { category: 'common_stock', reason: 'CN A股股票板代码段' };
    }
    if (CN_FUND_PREFIX.test(sym)) {
      return { category: 'etf', reason: 'CN 基金/ETF 代码段' };
    }
    return null;  // 北交所等未知段 → 保守保持 provisional
  }

  if (market === 'HK') {
    if (!nm) return null;
    // REIT（房产/产业基金信托）是普通股性质的研究对象，先于基金标记豁免
    if (HK_REIT_MARKER.test(nm)) {
      return { category: 'common_stock', reason: 'HK REIT（房产/产业信托）' };
    }
    // SPAC 先于轮证检查："收购"含"购"字，顺序颠倒会把 SPAC 误判为轮证
    if (HK_SPAC_MARKER.test(nm)) {
      return { category: 'other_non_common', reason: 'HK SPAC/收购公司' };
    }
    if (HK_WARRANT_MARKER.test(nm)) {
      return { category: 'warrant', reason: 'HK 轮证名称标记（购/沽/牛/熊）' };
    }
    if (HK_FUND_MARKER.test(nm) || HK_FUND_MARKER_EN.test(nm)) {
      return { category: 'etf', reason: 'HK 基金/ETF 名称标记' };
    }
    // HK 主板挂牌且无任何非普通股标记 → 普通股
    return { category: 'common_stock', reason: 'HK 无轮证/基金/SPAC标记' };
  }

  if (market === 'US') {
    if (!nm) return null;
    if (US_WARRANT_WORD.test(nm)) return { category: 'warrant', reason: 'US Warrant 名称词' };
    if (US_NOTE_WORD.test(nm)) return { category: 'note', reason: 'US Note 名称词' };
    if (US_UNIT_WORD.test(nm)) return { category: 'unit', reason: 'US Unit 名称词' };
    if (US_RIGHT_WORD.test(nm)) return { category: 'right', reason: 'US Right 名称词' };
    if (US_PREFERRED_WORD.test(nm)) return { category: 'preferred', reason: 'US 优先股/系列证券词' };
    if (US_FUND_FAMILY_SAFE.test(nm) || US_FUND_FAMILY_ANCHORED.test(nm)) {
      return { category: 'etf', reason: 'US 基金家族名' };
    }
    if (US_FUND_STRUCTURAL.test(nm)) {
      return { category: 'etf', reason: 'US 基金结构词（Fund/ETF/ETN/Portfolio）' };
    }
    // 剩余推定普通股：大公司已被证据路径（SEC 披露）先行定级，
    // 走到这里的无名标记标的绝大多数是无机构覆盖的小盘普通股。
    return { category: 'common_stock', reason: 'US 无基金/结构标记' };
  }

  return null;
}
