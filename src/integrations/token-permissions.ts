import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

/** Windows permission bits do not express ACLs; inspect read grants before reading a secret. */
export async function assertPrivateTokenFile(file: string, mode: number): Promise<void> {
  if (process.platform !== 'win32') {
    if ((mode & 0o077) !== 0) throw new Error('Invalid token file permissions');
    return;
  }
  const script = `
$ErrorActionPreference = 'Stop'
$acl = Get-Acl -LiteralPath $env:THESITCH_TOKEN_FILE
$allowed = @([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value, 'S-1-5-18', 'S-1-5-32-544')
foreach ($rule in $acl.Access) {
  $sid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
  if ($rule.AccessControlType -eq 'Allow' -and ($rule.FileSystemRights -band 1) -ne 0 -and $sid -notin $allowed) { exit 1 }
}
`;
  try {
    await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...process.env, THESITCH_TOKEN_FILE: file },
      timeout: 10000,
      windowsHide: true,
    });
  } catch {
    throw new Error('Restrict token file read access to your Windows account, Administrators and SYSTEM');
  }
}
