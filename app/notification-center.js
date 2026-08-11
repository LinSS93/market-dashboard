(function () {
  'use strict';

  let integration = { webhook:{ configured:false, masked:'', source:'none', provider:'none', editable:true } };
  let currentConfig = null;
  const $ = id => document.getElementById(id);
  const say = msg => typeof window.showToast === 'function' ? window.showToast(msg) : window.alert(msg);

  function browserState(cfg) {
    if (!('Notification' in window)) return { active:false, label:'当前浏览器不支持', tone:'off' };
    const enabled = cfg && cfg.browser !== false;
    const permission = Notification.permission;
    if (!enabled) return { active:false, label:'通道已关闭', tone:'off' };
    if (permission === 'granted') return { active:true, label:'已开启，可以接收桌面弹窗', tone:'on' };
    if (permission === 'denied') return { active:false, label:'浏览器已拒绝，请在站点权限中恢复', tone:'bad' };
    return { active:false, label:'等待浏览器授权', tone:'wait' };
  }

  function webhookState(cfg) {
    const f = integration.webhook || integration.feishu || {};
    if (!cfg || !cfg.feishu) return { active:false, label:f.configured?'通道已关闭':'尚未配置 Webhook', tone:'off' };
    if (!f.configured) return { active:false, label:'已打开开关，但尚未配置 Webhook', tone:'bad' };
    return { active:true, label:'已开启，服务端可后台推送', tone:'on' };
  }

  function setStatus(id, state) {
    const el=$(id); if (!el) return;
    el.className='alert-channel-state '+state.tone;
    el.textContent=state.label;
  }

  function render(cfg) {
    if (cfg) currentConfig=cfg;
    const activeCfg=currentConfig || { browser:true, feishu:false };
    const browser=browserState(activeCfg), webhook=webhookState(activeCfg);
    setStatus('browserStatusText', browser);
    setStatus('feishuStatusText', webhook);

    const f=integration.webhook || integration.feishu || {};
    const meta=$('webhookMeta');
    if (meta) {
      const source=f.source==='environment'?'环境变量':f.source==='local'?'本地加密隔离文件':'未配置';
      const provider=({feishu:'飞书 / Lark',slack:'Slack',discord:'Discord',generic:'通用 JSON'}[f.provider]||'Webhook');
      meta.textContent=f.configured ? `当前：${f.masked || '已配置'} · 类型：${provider} · 来源：${source}` : '尚未配置；支持常见平台及通用 HTTPS Webhook，完整地址不会回传到页面。';
    }
    const input=$('webhookInput');
    if (input) {
      input.disabled=f.editable===false;
      input.placeholder=f.editable===false?'由 WEBHOOK_URL 环境变量管理':(f.configured?'输入新地址可替换当前配置':'粘贴 HTTPS Webhook 地址');
    }
    const save=$('saveWebhookBtn'), clear=$('clearWebhookBtn'), test=$('testWebhookBtn');
    if (save) save.disabled=f.editable===false;
    if (clear) clear.disabled=f.editable===false || !f.configured;
    if (test) test.disabled=!f.configured;
    const grant=$('browserGrantBtn');
    if (grant) {
      grant.style.display=('Notification' in window && Notification.permission==='default')?'inline-flex':'none';
    }

    const button=$('notifyBtn');
    if (button) {
      const active=Number(browser.active)+Number(webhook.active);
      button.textContent=`🔔 提醒 ${active}/2`;
      button.title=`浏览器：${browser.label}；Webhook：${webhook.label}`;
      button.classList.toggle('channel-ready', active===2);
      button.classList.toggle('channel-partial', active===1);
    }
  }

  async function load(cfg) {
    if (cfg) currentConfig=cfg;
    try {
      const r=await fetch('/alerts/integration');
      if (!r.ok) throw new Error('读取失败');
      integration=await r.json();
    } catch {}
    render(currentConfig);
    return integration;
  }

  async function post(body) {
    const r=await fetch('/alerts/integration', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
    let data={}; try { data=await r.json(); } catch {}
    if (!r.ok || data.ok===false) throw new Error(data.error || '操作失败');
    if (data.webhook) integration.webhook=data.webhook;
    else if (data.feishu) integration.webhook=data.feishu;
    return data;
  }

  async function saveWebhook() {
    const input=$('webhookInput'), value=String(input&&input.value||'').trim();
    if (!value) { say('请先粘贴 HTTPS Webhook 地址'); return; }
    const btn=$('saveWebhookBtn'); if (btn) btn.disabled=true;
    try {
      await post({ action:'save', webhook:value });
      if (input) input.value='';
      say('Webhook 已安全保存并立即生效');
    } catch(e) { say(e.message); }
    finally { render(currentConfig); }
  }

  async function testWebhook() {
    const btn=$('testWebhookBtn'); if (btn) { btn.disabled=true; btn.textContent='发送中…'; }
    try { await post({ action:'test' }); say('测试消息已发送，请检查 Webhook 接收端'); }
    catch(e) { say('测试失败：'+e.message); }
    finally { if (btn) btn.textContent='发送测试'; render(currentConfig); }
  }

  async function clearWebhook() {
    if (!window.confirm('清除 Webhook 并关闭后台推送？')) return;
    try {
      const data=await post({ action:'clear' });
      if (currentConfig) currentConfig.feishu=false;
      const toggle=$('feishuChk'); if (toggle) toggle.checked=false;
      say('Webhook 已清除');
      if (data.settings && currentConfig) currentConfig.feishu=!!data.settings.feishu;
    } catch(e) { say(e.message); }
    finally { render(currentConfig); }
  }

  window.DashboardNotificationCenter={ load, render, saveWebhook, testWebhook, clearWebhook };
})();
