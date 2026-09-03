// 离线验证机会雷达飞书摘要的信息层级与文案边界。
import assert from 'node:assert/strict';
import { buildRadarDigestMessage } from '../alert_engine.mjs';

let assertions = 0;
function check(condition, message) { assert.ok(condition, message); assertions += 1; }

const crossConfirm = [
  { symbol: '02149', name: '贝克微', direction: 'positive', composite_score: 100, fact: 'BASE→BREAKOUT: 收盘 34.86 突破 20 日最高价 31.98，量比 6.68，RSI 66.16' },
  { symbol: '03931', name: '中创新航', direction: 'positive', composite_score: 98, fact: 'BASE→BREAKOUT: 收盘 21.24 突破 20 日最高价 20.06，量比 1.80，RSI 59.72' },
  { symbol: '01617', name: '南方通信', direction: 'positive', composite_score: 94, fact: 'profit_alert: POSITIVE PROFIT ALERT' },
  { symbol: '01028', name: '千百度', direction: 'positive', composite_score: 89, fact: 'profit_alert: POSITIVE PROFIT ALERT' },
  { symbol: '02605', name: 'METALIGHT', direction: 'positive', composite_score: 89, fact: 'profit_alert: POSITIVE PROFIT ALERT - REDUCTION IN LOSS' },
];
const risks = [
  { symbol: '02457', name: '步阳国际', direction: 'negative', composite_score: 88, fact: 'profit_alert: PROFIT WARNING' },
  { symbol: '00983', name: '瑞安建业', direction: 'negative', composite_score: 85, fact: 'profit_alert: FINANCIAL PERFORMANCE UPDATE' },
  { symbol: '00731', name: '建发新胜', direction: 'negative', composite_score: 77, fact: 'profit_alert: REDUCTION OF LOSS' },
  { symbol: '08219', name: '恒伟集团控股', direction: 'negative', composite_score: 75, fact: 'profit_alert: PROFIT ALERT' },
];
const newSignals = Array.from({ length: 90 }, (_, index) => ({
  symbol: `N${String(index + 1).padStart(3, '0')}`, name: `新变化${index + 1}`, direction: 'positive',
  composite_score: 94 - index / 10, fact: 'BREAKOUT→TREND: MA20 1.82 > MA60 1.76，5 日斜率 5.62%，收盘 2.04 站上 MA20',
}));

const message = buildRadarDigestMessage('HK', { risks, crossConfirm, newSignals }, ['risk', 'confirmed', 'new']);
console.log(message);

check(message.startsWith('【机会雷达｜港股盘后】'), '标题只保留市场与盘后时点');
check(message.includes('优先 5｜风险 4｜新变化 90'), '首屏汇总三个研究队列的实际数量');
check(message.includes('优先：02149 贝克微 100分｜站上 20 日新高，量比 6.7'), '首条优先对象保留代码、名称、研究排序与唯一触发事实');
check(message.includes('      03931 中创新航 98分｜站上 20 日新高，量比 1.8'), '最多保留第二条优先对象');
check(message.includes('风险：02457 步阳国际 88分｜业绩预警：利润可能承压'), '风险组只保留首条最需核验对象');
check(!message.includes('BASE→BREAKOUT') && !message.includes('POSITIVE PROFIT ALERT') && !message.includes('REDUCTION OF LOSS'), '不平铺内部状态机和英文公告标题');
check(!message.includes('RSI') && !message.includes('研究摘要') && !message.includes('分数只用于'), '删除次要指标、解释段落与重复免责声明');
check(!message.includes('01617') && !message.includes('00983') && !message.includes('N001'), '长名单不再占用推送正文');
check(message.split('\n').length === 6, '完整通知固定为一屏六行');
check(message.endsWith('查看：机会雷达 → 持续研究候选池'), '提供唯一下一步入口');

const onlyNew = buildRadarDigestMessage('US', { risks, crossConfirm, newSignals }, ['new']);
check(onlyNew.includes('优先 0｜风险 0｜新变化 90'), '关闭分组时摘要按实际推送范围计数');
check(!onlyNew.includes('N001') && onlyNew.split('\n').length === 3, '只有新变化时只报数量和查看入口');

console.log(`\n${assertions}/${assertions} assertions passed`);
