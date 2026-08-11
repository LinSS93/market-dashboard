(() => {
  const form = document.getElementById('loginForm');
  const hint = document.getElementById('loginHint');
  const error = document.getElementById('loginError');
  const next = new URLSearchParams(location.search).get('next');
  const target = next && next.startsWith('/') && !next.startsWith('//') ? next : '/stock';

  async function init() {
    const response = await fetch('/auth/status', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error('无法读取登录状态。');
    if (data.authenticated) return location.replace(target);
    if (data.setupRequired) return location.replace(`/setup?next=${encodeURIComponent(target)}`);
    document.getElementById('username').focus();
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.textContent = '';
    const button = form.querySelector('button');
    button.disabled = true;
    try {
      const response = await fetch('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: document.getElementById('username').value,
          password: document.getElementById('password').value,
          remember: document.getElementById('remember').checked,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) throw new Error(data.error || '登录失败。');
      location.replace(target);
    } catch (err) {
      error.textContent = err.message || '登录失败。';
    } finally {
      button.disabled = false;
    }
  });

  init().catch((err) => { hint.textContent = err.message || '服务暂不可用，请稍后再试。'; });
})();
