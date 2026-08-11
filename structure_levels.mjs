// 结构化技术点位（v1）：基于市场结构识别真实的供需博弈位，
// 替代 ATR 测距式价位（buyHigh+2ATR 等）。
//
// 三级实现：
//   1) pivot 高低点（波段极值点）—— 左 N 右 N 比较法
//   2) 缺口识别（跳空缺口，未回补的视为支撑/阻力）
//   3) 成交密集区 POC / Value Area（按价位分桶累计成交量）
//
// 设计原则：
//   - 纯函数，输入 OHLCV 行序列，输出结构化价位数组
//   - 不依赖 db / 不依赖外部状态，可独立测试
//   - 输出格式统一：{ price, type, label, strength, date }
//     type: 'resistance'|'support'|'gap_up'|'gap_down'|'poc'|'vah'|'val'
//     strength: 1-3（触次数或成交量权重）
//   - 仅展示用，不参与信号引擎决策（computeSwingZones 保持原样）

// ── 第一级：pivot 高低点检测 ──────────────────────────────────────────────
// 经典 pivot point：某根 K 线的 high/low 是左 N 根和右 N 根中的极值。
// N=3 是 swing trader 常用的窗口（约一周的交易日）。
//
// 输入：rows = [{ date, open, high, low, close, volume }, ...]
// 输出：[{ date, price, type:'resistance'|'support', strength, pivotIndex }]
//   - resistance: 波段高点（价格向上反弹位）
//   - support: 波段低点（价格向下支撑位）
//   - strength: 1-3，按 pivot 窗口大小分级（N=2→1, N=3→2, N=5→3）
//   - 仅返回最近 120 根 K 线内的 pivot，避免历史噪音
export function detectPivotLevels(rows, { leftRight = 3, lookback = 120 } = {}) {
  if (!Array.isArray(rows) || rows.length < leftRight * 2 + 1) return [];
  const n = Math.max(1, Math.min(10, Number(leftRight) || 3));
  const startIdx = Math.max(0, rows.length - Math.min(rows.length, Number(lookback) || 120));
  const out = [];

  for (let i = startIdx + n; i < rows.length - n; i++) {
    const cur = rows[i];
    if (!cur || cur.high == null || cur.low == null) continue;

    // 检查是否为波段高点：左右 n 根的 high 都严格小于当前 high
    let isHigh = true;
    for (let j = i - n; j <= i + n; j++) {
      if (j === i) continue;
      if (Number(rows[j]?.high) >= Number(cur.high)) { isHigh = false; break; }
    }
    if (isHigh) {
      out.push({
        date: cur.date, price: Number(cur.high), type: 'resistance',
        label: '波段高点', strength: n >= 5 ? 3 : n >= 3 ? 2 : 1, pivotIndex: i,
      });
      continue; // 同一根 K 线不会同时是高低点
    }

    // 检查是否为波段低点：左右 n 根的 low 都严格大于当前 low
    let isLow = true;
    for (let j = i - n; j <= i + n; j++) {
      if (j === i) continue;
      if (Number(rows[j]?.low) <= Number(cur.low)) { isLow = false; break; }
    }
    if (isLow) {
      out.push({
        date: cur.date, price: Number(cur.low), type: 'support',
        label: '波段低点', strength: n >= 5 ? 3 : n >= 3 ? 2 : 1, pivotIndex: i,
      });
    }
  }

  // 聚合相近价位（±0.5%）：多次触碰的价位 strength 提升
  return aggregateNearbyLevels(out, 0.005);
}

// ── 第二级：缺口识别 ──────────────────────────────────────────────────────
// 跳空缺口：当日 low > 昨日 high（向上缺口）或 当日 high < 昨日 low（向下缺口）。
// 未回补的缺口是强支撑/阻力。
//
// 输入：rows = [{ date, open, high, low, close, volume }, ...]
// 输出：[{ date, price, type:'gap_up'|'gap_down', gapLow, gapHigh, label, strength, filled }]
//   - gap_up: 向上缺口（支撑位，缺口下沿）
//   - gap_down: 向下缺口（阻力位，缺口上沿）
//   - price: 支撑/阻力的参考价位（gap_up 用 gapLow，gap_down 用 gapHigh）
//   - gapLow/gapHigh: 缺口区间
//   - filled: 是否已被回补
//   - strength: 缺口大小占价格的百分比决定（>2% → 3, >1% → 2, 否则 1）
//   - 仅返回最近 120 根 K 线内的缺口
export function detectGapLevels(rows, { lookback = 120, minGapPct = 0.003 } = {}) {
  if (!Array.isArray(rows) || rows.length < 2) return [];
  const lookbackN = Math.min(rows.length - 1, Number(lookback) || 120);
  const startIdx = rows.length - lookbackN;
  const out = [];

  for (let i = Math.max(1, startIdx); i < rows.length; i++) {
    const prev = rows[i - 1];
    const cur = rows[i];
    if (!prev || !cur) continue;
    const prevHigh = Number(prev.high), prevLow = Number(prev.low);
    const curHigh = Number(cur.high), curLow = Number(cur.low);
    if (![prevHigh, prevLow, curHigh, curLow].every(Number.isFinite)) continue;

    const refPrice = (prevHigh + prevLow) / 2 || curHigh;
    if (refPrice <= 0) continue;

    // 向上缺口：当日最低 > 昨日最高
    if (curLow > prevHigh) {
      const gapPct = (curLow - prevHigh) / refPrice;
      if (gapPct >= minGapPct) {
        // 检查是否已回补：后续某根 K 线的 low 跌破缺口下沿（prevHigh）
        let filled = false;
        for (let j = i + 1; j < rows.length; j++) {
          if (Number(rows[j]?.low) <= prevHigh) { filled = true; break; }
        }
        out.push({
          date: cur.date, price: prevHigh, type: 'gap_up',
          gapLow: prevHigh, gapHigh: curLow,
          label: '向上缺口', strength: gapPct >= 0.02 ? 3 : gapPct >= 0.01 ? 2 : 1,
          filled, gapPct: +(gapPct * 100).toFixed(2),
        });
      }
    }

    // 向下缺口：当日最高 < 昨日最低
    if (curHigh < prevLow) {
      const gapPct = (prevLow - curHigh) / refPrice;
      if (gapPct >= minGapPct) {
        let filled = false;
        for (let j = i + 1; j < rows.length; j++) {
          if (Number(rows[j]?.high) >= prevLow) { filled = true; break; }
        }
        out.push({
          date: cur.date, price: prevLow, type: 'gap_down',
          gapLow: curHigh, gapHigh: prevLow,
          label: '向下缺口', strength: gapPct >= 0.02 ? 3 : gapPct >= 0.01 ? 2 : 1,
          filled, gapPct: +(gapPct * 100).toFixed(2),
        });
      }
    }
  }

  // 未回补的缺口优先返回；已回补的降级为弱参考
  return out;
}

// ── 第三级：成交密集区 POC / Value Area ────────────────────────────────────
// 按价位分桶累计成交量，找出成交量最大的价位（POC）和 70% 成交量区间（Value Area）。
//
// 算法（Market Profile 简化版）：
//   1) 取最近 N 根 K 线的价格范围 [minLow, maxHigh]，分成 M 个等价位桶
//   2) 每根 K 线的成交量按 (high-low) 线性分摊到覆盖的桶
//   3) POC = 成交量最大的桶的中点
//   4) Value Area = 从 POC 向上下扩展，累计 70% 成交量的价位区间 [VAL, VAH]
//
// 输入：rows = [{ date, open, high, low, close, volume }, ...]
// 输出：[{ price, type:'poc'|'vah'|'val', label, strength, volumePct }]
//   - poc: 成交控制点（成交量最大的价位）
//   - vah: Value Area High（价值区上沿）
//   - val: Value Area Low（价值区下沿）
//   - volumePct: 该桶成交量占总成交量的百分比
//   - strength: POC=3, VAH/VAL=2
export function detectVolumeProfile(rows, { lookback = 90, bins = 40, valueAreaPct = 0.70 } = {}) {
  if (!Array.isArray(rows) || rows.length < 10) return [];
  const lookbackN = Math.min(rows.length, Number(lookback) || 90);
  const sample = rows.slice(-lookbackN).filter(r =>
    r && Number.isFinite(Number(r.high)) && Number.isFinite(Number(r.low)) && Number.isFinite(Number(r.volume)) && Number(r.volume) > 0
  );
  if (sample.length < 10) return [];

  let minLow = Infinity, maxHigh = -Infinity, totalVolume = 0;
  for (const r of sample) {
    minLow = Math.min(minLow, Number(r.low));
    maxHigh = Math.max(maxHigh, Number(r.high));
    totalVolume += Number(r.volume);
  }
  if (!Number.isFinite(minLow) || !Number.isFinite(maxHigh) || maxHigh <= minLow || totalVolume <= 0) return [];

  const binCount = Math.max(10, Math.min(100, Number(bins) || 40));
  const binSize = (maxHigh - minLow) / binCount;
  const binVolumes = new Array(binCount).fill(0);

  // 每根 K 线的成交量按价格区间线性分摊到覆盖的桶
  for (const r of sample) {
    const rLow = Number(r.low), rHigh = Number(r.high), rVol = Number(r.volume);
    const range = rHigh - rLow;
    if (range <= 0) {
      // doji / 一字板：全部成交量归入当前 close 所在桶
      const close = Number(r.close);
      const idx = Math.min(binCount - 1, Math.max(0, Math.floor((close - minLow) / binSize)));
      binVolumes[idx] += rVol;
    } else {
      const startBin = Math.floor((rLow - minLow) / binSize);
      const endBin = Math.floor((rHigh - minLow) / binSize);
      const s = Math.max(0, Math.min(binCount - 1, startBin));
      const e = Math.max(0, Math.min(binCount - 1, endBin));
      if (s === e) {
        binVolumes[s] += rVol;
      } else {
        // 线性分摊：按每个桶覆盖的价格比例分配
        const volPerPrice = rVol / range;
        for (let b = s; b <= e; b++) {
          const binLow = minLow + b * binSize;
          const binHigh = binLow + binSize;
          const overlapLow = Math.max(binLow, rLow);
          const overlapHigh = Math.min(binHigh, rHigh);
          const overlap = Math.max(0, overlapHigh - overlapLow);
          binVolumes[b] += volPerPrice * overlap;
        }
      }
    }
  }

  // POC = 成交量最大的桶
  let pocBin = 0, pocVol = 0;
  for (let b = 0; b < binCount; b++) {
    if (binVolumes[b] > pocVol) { pocVol = binVolumes[b]; pocBin = b; }
  }
  const pocPrice = minLow + (pocBin + 0.5) * binSize;
  const pocVolumePct = totalVolume > 0 ? (pocVol / totalVolume) * 100 : 0;

  // Value Area：从 POC 向上下扩展，累计 70% 成交量
  const targetVolume = totalVolume * Number(valueAreaPct);
  let vaVolume = pocVol;
  let lowBin = pocBin, highBin = pocBin;
  while (vaVolume < targetVolume && (lowBin > 0 || highBin < binCount - 1)) {
    const downVol = lowBin > 0 ? binVolumes[lowBin - 1] : -1;
    const upVol = highBin < binCount - 1 ? binVolumes[highBin + 1] : -1;
    if (downVol >= upVol && downVol >= 0) {
      lowBin--;
      vaVolume += downVol;
    } else if (upVol >= 0) {
      highBin++;
      vaVolume += upVol;
    } else {
      break;
    }
  }
  const valPrice = minLow + (lowBin + 0.5) * binSize;
  const vahPrice = minLow + (highBin + 0.5) * binSize;

  return [
    { price: pocPrice, type: 'poc', label: '成交密集区', strength: 3, volumePct: +pocVolumePct.toFixed(1) },
    { price: vahPrice, type: 'vah', label: '价值区上沿', strength: 2, volumePct: null },
    { price: valPrice, type: 'val', label: '价值区下沿', strength: 2, volumePct: null },
  ];
}

// ── 统一入口：计算全部结构化价位 ───────────────────────────────────────────
// 输入：rows = [{ date, open, high, low, close, volume }, ...]（日 K 序列）
// 输出：{ pivots, gaps, volumeProfile, all }
//   - all: 合并去重后的价位列表，按价格排序，供前端绘制水平线
export function computeStructureLevels(rows, options = {}) {
  if (!Array.isArray(rows) || rows.length < 10) {
    return { pivots: [], gaps: [], volumeProfile: [], all: [] };
  }
  const safeRows = rows.map(r => ({
    date: String(r.date || ''),
    open: Number(r.open), high: Number(r.high), low: Number(r.low),
    close: Number(r.close), volume: Number(r.volume),
  })).filter(r => Number.isFinite(r.high) && Number.isFinite(r.low) && Number.isFinite(r.close));

  const pivots = detectPivotLevels(safeRows, options.pivot);
  const gaps = detectGapLevels(safeRows, options.gap);
  const volumeProfile = detectVolumeProfile(safeRows, options.volumeProfile);

  // 合并去重：相近价位（±0.3%）合并为一个，保留 strength 最高的
  const all = aggregateNearbyLevels(
    [...pivots, ...gaps.filter(g => !g.filled), ...volumeProfile],
    0.003
  ).sort((a, b) => Number(a.price) - Number(b.price));

  return { pivots, gaps, volumeProfile, all };
}

// ── 工具：聚合相近价位 ─────────────────────────────────────────────────────
// tolerance: 价位容差比例（如 0.005 = 0.5%）
// 相近价位合并后，strength 取最大值，type/label 保留 strength 最高的那条
function aggregateNearbyLevels(levels, tolerance = 0.005) {
  if (!Array.isArray(levels) || levels.length === 0) return [];
  const sorted = [...levels].sort((a, b) => Number(a.price) - Number(b.price));
  const out = [];
  let cluster = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const last = cluster[cluster.length - 1];
    const cur = sorted[i];
    if (Math.abs(Number(cur.price) - Number(last.price)) / (Number(last.price) || 1) <= tolerance) {
      cluster.push(cur);
    } else {
      out.push(mergeCluster(cluster));
      cluster = [cur];
    }
  }
  out.push(mergeCluster(cluster));
  return out;
}

function mergeCluster(cluster) {
  if (cluster.length === 1) return cluster[0];
  // 保留 strength 最高的作为主条目，合并触次数
  const best = cluster.reduce((a, b) => (Number(b.strength) > Number(a.strength) ? b : a));
  const touchCount = cluster.length;
  return {
    ...best,
    price: cluster.reduce((s, x) => s + Number(x.price), 0) / cluster.length,
    strength: Math.min(3, Number(best.strength) + (touchCount > 1 ? 1 : 0)),
    touchCount,
    mergedFrom: cluster.map(c => c.type),
  };
}
