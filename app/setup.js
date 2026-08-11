(() => {
  const form = document.getElementById('setupForm');
  const hint = document.getElementById('setupHint');
  const error = document.getElementById('setupError');
  const next = new URLSearchParams(location.search).get('next');
  const target = next && next.startsWith('/') && !next.startsWith('//') ? next : '/stock';

  async function init() {
    const response = await fetch('/auth/status', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error('无法读取初始化状态。');
    if (data.authenticated) return location.replace(target);
    if (!data.setupRequired) return location.replace(`/login?next=${encodeURIComponent(target)}`);
    document.getElementById('setupUsername').focus();
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.textContent = '';
    const password = document.getElementById('setupPassword').value;
    const passwordConfirm = document.getElementById('setupPasswordConfirm').value;
    if (password !== passwordConfirm) {
      error.textContent = '两次输入的密码不一致。';
      return;
    }
    const button = form.querySelector('button');
    button.disabled = true;
    try {
      const response = await fetch('/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: document.getElementById('setupUsername').value, password, passwordConfirm }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) throw new Error(data.error || '管理员创建失败。');
      location.replace(target);
    } catch (err) {
      error.textContent = err.message || '管理员创建失败。';
    } finally {
      button.disabled = false;
    }
  });

  init().catch((err) => { hint.textContent = err.message || '服务暂不可用，请稍后再试。'; });
})();
