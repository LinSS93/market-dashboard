import { adminAuth } from '../auth.mjs';

const args = process.argv.slice(2);
const usernameIndex = args.indexOf('--username');
const username = usernameIndex >= 0 ? args[usernameIndex + 1] : 'admin';

if (!args.includes('--stdin')) {
  console.error('为避免密码出现在命令历史中，请通过 PowerShell 包装脚本运行：');
  console.error('  powershell -ExecutionPolicy Bypass -File scripts/reset-admin-password.ps1');
  process.exit(2);
}

let password = '';
for await (const chunk of process.stdin) password += chunk;
password = password.replace(/[\r\n]+$/, '');
try {
  const result = adminAuth.resetPassword({ username, password });
  console.log(`管理员 ${result.username} 的密码已重置。所有已登录会话已失效。`);
} catch (error) {
  console.error(`重置失败：${error.message}`);
  process.exitCode = 1;
}
