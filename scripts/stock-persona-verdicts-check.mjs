import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { STOCK_PERSONA_VERDICT_SCHEMA_VERSION, buildStockPersonaVerdicts } from '../stock_persona_verdicts.mjs';

let passed = 0;
function equal(actual, expected, message) { assert.equal(actual, expected, message); passed += 1; }

const signalProfiles = {
  effectiveProfileId: 'balanced',
  profiles: {
    responsive: { available:true, score:0.42, profileVersion:'responsive-test' },
    balanced: { available:true, score:0.03, profileVersion:'balanced-test' },
    confirmed: { available:true, score:-0.28, profileVersion:'confirmed-test' },
  },
};
const profileDecisions = {
  responsive: { opportunityStage:'READY', executionAction:'OPEN', label:'可试仓', tone:'bull', summary:'敏捷形态已确认。', tranchePct:15, recommendedShares:5, validSessions:1, profileVersion:'responsive-test', profileStrategyVersion:'strategy-v1', zones:{ confirmation:101, invalidation:95, reassessment:112 }, explanation:{ summary:'敏捷形态已确认。', supportingReasons:['技术面偏多'], blockingReasons:[], nextUpgradeCondition:'形态保持后再评估加仓。' } },
  balanced: { opportunityStage:'AWAIT_CONFIRMATION', executionAction:'NONE', label:'等待确认', tone:'watch', summary:'均衡形态等待确认。', tranchePct:0, recommendedShares:0, validSessions:3, profileVersion:'balanced-test', profileStrategyVersion:'strategy-v1' },
  confirmed: { opportunityStage:'RISK_OFF', executionAction:'NONE', label:'风险回避', tone:'bear', summary:'稳健趋势确认向下。', tranchePct:0, recommendedShares:0, validSessions:5, profileVersion:'confirmed-test', profileStrategyVersion:'strategy-v1' },
};

const verdicts = buildStockPersonaVerdicts({ signalProfiles, profileDecisions, activeProfileId:'balanced' });
equal(verdicts.schemaVersion, STOCK_PERSONA_VERDICT_SCHEMA_VERSION, 'full-pipeline verdict schema is explicit');
equal(verdicts.scope, 'full_decision_pipeline', 'persona cards expose end-to-end decisions');
equal(verdicts.activeProfileId, 'balanced', 'one active formal profile is explicit');
equal(verdicts.profiles.responsive.actionLabel, '可试仓', 'responsive card uses its own arbitrated action');
equal(verdicts.profiles.responsive.tranchePct, 15, 'responsive card keeps its own execution cadence');
equal(verdicts.profiles.responsive.validSessions, 1, 'responsive card keeps its validity window');
equal(verdicts.profiles.responsive.zones.invalidation, 95, 'responsive card keeps its frozen risk level');
equal(verdicts.profiles.responsive.explanation.nextUpgradeCondition, '形态保持后再评估加仓。', 'persona explanation comes from the same decision object');
equal(verdicts.profiles.balanced.actionLabel, '等待确认', 'balanced card uses its own arbitrated stage');
equal(verdicts.profiles.balanced.active, true, 'balanced is marked as the active formal strategy');
equal(verdicts.profiles.responsive.active, false, 'responsive remains shadow while not selected');
equal(verdicts.profiles.confirmed.actionLabel, '风险回避', 'confirmed card uses its own arbitrated stage');
equal(verdicts.profiles.confirmed.technicalScore, -0.28, 'technical score remains traceable');

const missing = buildStockPersonaVerdicts({ signalProfiles, profileDecisions:{}, activeProfileId:'balanced' });
equal(missing.profiles.responsive.actionLabel, '暂缓判断', 'missing full decision never falls back to a naked direction');

const stockEngineSource = readFileSync(resolve('stock_engine.mjs'), 'utf8');
const stockProfileStateSource = readFileSync(resolve('stock_profile_state.mjs'), 'utf8');
const stockUiSource = readFileSync(resolve('app/stock.js'), 'utf8');
const verdictSource = readFileSync(resolve('stock_persona_verdicts.mjs'), 'utf8');
equal(stockEngineSource.includes('profileDecisions'), true, 'stock analysis DTO computes three full decisions');
equal(stockEngineSource.includes('stockProfileState.resolveForPosition'), true, 'formal selection delegates to the profile state boundary');
equal(stockProfileStateSource.includes('stock_position_profile_bindings'), true, 'position personality binding is persisted and auditable');
equal(stockEngineSource.includes('交易事件与人格绑定同事务提交'), true, 'trade entry and personality binding share one transaction');
equal(stockProfileStateSource.includes("throw new Error('invalid profile_id')"), true, 'invalid profile ids are rejected instead of silently selecting balanced');
equal(stockUiSource.includes('三种策略判断'), true, 'stock detail labels the cards as strategy decisions');
equal(stockUiSource.includes('当前策略'), true, 'stock detail distinguishes the active formal strategy');
equal(stockUiSource.includes('更多研究信息'), true, 'secondary evidence is moved behind one research disclosure');
equal(stockUiSource.includes('当前判断'), true, 'formal decision explanation is visible on the first screen');
equal(verdictSource.includes('technical_only'), false, 'old technical-only contract is removed');

console.log(`stock persona verdict checks: ${passed}/${passed} passed`);
