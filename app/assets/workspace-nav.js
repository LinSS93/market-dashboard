(() => {
  // On 部署环境 the boards and APIs share an HTTP/1.1 origin. Leave connections
  // available for the next document even when several API reads are stalled.
  const fetchNow = window.fetch.bind(window);
  const waiting = [];
  let activeReads = 0;
  window.fetch = async (input, options) => {
    const request = input instanceof Request ? input : null;
    const method = (options?.method || request?.method || 'GET').toUpperCase();
    if (method !== 'GET' || new URL(request?.url || input, document.baseURI).origin !== location.origin) {
      return fetchNow(input, options);
    }
    const signal = options?.signal || request?.signal;
    signal?.throwIfAborted();
    if (activeReads < 4) {
      activeReads++;
    } else {
      await new Promise((resolve, reject) => {
        const start = () => {
          signal?.removeEventListener('abort', cancel);
          resolve();
        };
        const cancel = () => {
          waiting.splice(waiting.indexOf(start), 1);
          reject(signal.reason);
        };
        waiting.push(start);
        signal?.addEventListener('abort', cancel, {once:true});
      });
    }
    try {
      return await fetchNow(input, options);
    } finally {
      const next = waiting.shift();
      if (next) next();
      else activeReads--;
    }
  };
  const pages = [
    ['/stock', '股票监控'],
    ['/tracker', '杠杆 ETF 追踪'],
    ['/assets/rsi6.html', 'RSI6 扫描器'],
    ['/radar', '机会雷达'],
    ['/macro', '宏观看板'],
    ['/lab', '实验室'],
    ['/control', '控制中心'],
  ];
  const header = document.querySelector('.workspace-header');
  const brand = header.querySelector('h1 a');
  const current = pages.find(([path]) => path === location.pathname);
  if (location.pathname === '/') brand.setAttribute('aria-current', 'page');

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'workspace-menu-toggle';
  toggle.textContent = current?.[1] || '工作台首页';
  toggle.setAttribute('aria-label', '切换看板，当前为' + toggle.textContent);
  toggle.setAttribute('aria-controls', 'workspace-menu');
  toggle.setAttribute('aria-expanded', 'false');

  const menu = document.createElement('div');
  menu.id = 'workspace-menu';
  const nav = document.createElement('nav');
  nav.setAttribute('aria-label', '看板导航');
  const icons = [
    'M4 17V9m5 8V4m5 13v-6m5 6V7',
    'M3 16l5-7 4 3 8-8M3 20l5-6 4 2 8-8',
    'M2 12h5l3-7 4 14 3-7h5',
    'M12 3a9 9 0 1 0 9 9M12 7a5 5 0 1 0 5 5M12 12l8-8',
    'M3 18h18M4 14l5-5 4 2 7-7',
    'M9 3h6m-5 0v6l-6 10a1 1 0 0 0 1 2h14a1 1 0 0 0 1-2L14 9V3M7 15h10',
    'M3 7h7m4 0h7M3 17h11m4 0h3M10 4v6m6 4v6'
  ];
  const destinations = [['/', '工作台总览'], ...pages];
  for (const [i, [path, name]] of destinations.entries()) {
    const link = document.createElement('a');
    link.href = path;
    link.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="'+(icons[i-1] || 'M3 4h7v7H3z M14 4h7v7h-7z M3 15h7v6H3z M14 15h7v6h-7z')+'"/></svg>';
    link.append(name);
    if (path === location.pathname) link.setAttribute('aria-current', 'page');
    nav.append(link);
  }
  menu.append(nav);
  const status = header.querySelector('.workspace-header-status');
  if (status) {
    const markets = status.querySelector('#mktStatus');
    if (markets) {
      const disclosure = document.createElement('details');
      disclosure.className = 'market-session';
      const summary = document.createElement('summary');
      summary.innerHTML = '<strong>市场时段</strong><span id="sessionSummary">正在读取</span>';
      for (const node of [...status.children]) if (node !== markets) summary.append(node);
      disclosure.append(summary,markets);
      const strip = document.createElement('div');
      strip.className = 'session-line';
      strip.append(disclosure);
      header.after(strip);
      status.remove();
    } else {
      status.classList.add('page-status');
      header.after(status);
    }
  }
  header.append(toggle, menu);

  const close = () => toggle.setAttribute('aria-expanded', 'false');
  toggle.addEventListener('click', () => {
    toggle.setAttribute('aria-expanded', String(toggle.getAttribute('aria-expanded') !== 'true'));
  });
  document.addEventListener('click', e => { if (!header.contains(e.target)) close(); });
  header.addEventListener('focusout', e => { if (!header.contains(e.relatedTarget)) close(); });
  header.addEventListener('keydown', e => {
    if (e.key === 'Escape' && toggle.getAttribute('aria-expanded') === 'true') {
      close();
      toggle.focus();
    }
  });
  nav.addEventListener('click', close);
  matchMedia('(max-width: 1040px)').addEventListener('change', close);
  window.addEventListener('pageshow', close);
})();
