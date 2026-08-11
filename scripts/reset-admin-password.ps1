[CmdletBinding()]
param(
  [ValidatePattern('^[a-zA-Z0-9_.-]{1,64}$')]
  [string]$Username = 'admin'
)

$securePassword = Read-Host '输入新的 Market Dashboard 管理员密码（至少 12 位）' -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
try {
  $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  $plainPassword | & node scripts/reset-admin-password.mjs --stdin --username $Username
  exit $LASTEXITCODE
}
finally {
  if ($bstr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
  Remove-Variable plainPassword -ErrorAction SilentlyContinue
}
