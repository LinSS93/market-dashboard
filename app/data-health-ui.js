(function(){
  function esc(s){return String(s??'').replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));}
  function ensureModal(){
    let root=document.getElementById('dataHealthModal');if(root)return root;
    root=document.createElement('div');root.id='dataHealthModal';root.className='modal';
    root.innerHTML='<div class="modal-box data-health-box"><span class="closeX" onclick="DashboardDataHealth.close()">×</span><h2>数据与备份状态</h2><div id="dataHealthBody" class="data-health-body"><div class="hint">正在检查…</div></div><div class="data-health-actions"><button class="btn ghost" onclick="DashboardDataHealth.createBackup()">立即备份</button><a class="btn ghost" href="/backup/download">下载数据库</a><a class="btn ghost" href="/backup/export">导出配置</a></div></div>';
    root.addEventListener('click',e=>{if(e.target===root)window.DashboardDataHealth.close();});document.body.appendChild(root);return root;
  }
  function row(x){const status=x.status||'unknown',label={fresh:'正常',stale:'陈旧',error:'失败',unknown:'未知'}[status]||status;return '<tr><td>'+esc(x.name||x.symbol||x.pair||'—')+'</td><td><span class="health-status '+status+'">'+label+'</span></td><td>'+esc(x.source||'—')+'</td><td>'+esc(x.provider_time||x.updated||'—')+'</td><td>'+esc(x.detail||'')+'</td></tr>';}
  window.DashboardDataHealth={
    async open(){const root=ensureModal();root.style.display='flex';const body=document.getElementById('dataHealthBody');body.innerHTML='<div class="hint">正在检查…</div>';try{const j=await fetch('/data/health',{cache:'no-store'}).then(r=>r.json()),rows=[...(j.stocks||[]),...(j.trackers||[]),...(j.fx||[])];body.innerHTML='<div class="health-summary">'+esc(j.summary||'')+'</div><div class="signal-alert-audit"><table><thead><tr><th>数据项</th><th>状态</th><th>来源</th><th>时间</th><th>说明</th></tr></thead><tbody>'+rows.map(row).join('')+'</tbody></table></div><div class="backup-summary">最近备份：'+esc(j.backup?.latest||'尚无')+' · 保留 '+Number(j.backup?.count||0)+' 份</div>';}catch(e){body.innerHTML='<div class="hint">诊断接口读取失败：'+esc(e.message)+'</div>';}},
    close(){const x=document.getElementById('dataHealthModal');if(x)x.style.display='none';},
    async createBackup(){const body=document.getElementById('dataHealthBody');try{const j=await fetch('/backup/create',{method:'POST'}).then(r=>r.json());if(!j.ok)throw new Error(j.error||'备份失败');await this.open();}catch(e){if(body)body.insertAdjacentHTML('afterbegin','<div class="hint">'+esc(e.message)+'</div>');}}
  };
})();
