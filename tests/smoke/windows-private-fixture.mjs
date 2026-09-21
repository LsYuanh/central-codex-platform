// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Tests only. Call exclusively for this run's newly created synthetic fixture.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {lstatSync, realpathSync} from 'node:fs';
import {isAbsolute, join, relative} from 'node:path';

export function protectSyntheticFixture(root, paths = [root]) {
  if (process.platform !== 'win32') return;
  assert(isAbsolute(root) && realpathSync(root) === root);
  for (const path of paths) {
    const child = relative(root, path), stat = lstatSync(path);
    assert(child === '' || (!child.startsWith('..') && !isAbsolute(child)), 'QA_ACL_TARGET_OUTSIDE_FIXTURE');
    assert(realpathSync(path) === path && !stat.isSymbolicLink() && (stat.isDirectory() || stat.isFile() && stat.nlink === 1), 'QA_ACL_TARGET_UNSAFE');
  }
  const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  $fixturePaths = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $fixtureSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $fixtureSddl = 'D:P(A;;FA;;;{0})' -f $fixtureSid
  foreach ($fixturePath in $fixturePaths) {
    $fixtureItem = Get-Item -LiteralPath $fixturePath -Force
    $fixtureAcl = Get-Acl -LiteralPath $fixturePath
    if ($fixtureAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $fixtureSid) { throw 'QA_FIXTURE_OWNER_INVALID' }
    $fixtureRules = $fixtureAcl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])
    if ($fixtureAcl.AreAccessRulesProtected -and $fixtureRules.Count -eq 1) {
      $fixtureRule = $fixtureRules[0]
      if ($fixtureRule.IdentityReference.Value -eq $fixtureSid -and
          $fixtureRule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
          -not $fixtureRule.IsInherited -and
          $fixtureRule.InheritanceFlags -eq [Security.AccessControl.InheritanceFlags]::None -and
          $fixtureRule.PropagationFlags -eq [Security.AccessControl.PropagationFlags]::None -and
          ($fixtureRule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl) { continue }
    }
    # Newly created fixtures already have the correct owner. Updating owner/group
    # again can require SeRestorePrivilege; change only this fixture's DACL.
    $fixtureAcl.SetSecurityDescriptorSddlForm($fixtureSddl, [Security.AccessControl.AccessControlSections]::Access)
    Set-Acl -LiteralPath $fixturePath -AclObject $fixtureAcl
  }
} catch { [Console]::Error.WriteLine('QA_PRIVATE_FIXTURE_ACL_FAILED ' + $_.FullyQualifiedErrorId + ' ' + $_.Exception.GetType().FullName); exit 1 }
`;
  const powershellHome = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0');
  const env = {PSModulePath: join(powershellHome, 'Modules')};
  for (const name of ['SystemRoot', 'WINDIR', 'SystemDrive', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA'])
    if (process.env[name] !== undefined) env[name] = process.env[name];
  // PowerShell 7's inherited PSModulePath can select incompatible .NET modules
  // inside Windows PowerShell 5.1. Load only the latter's bundled modules.
  const result = spawnSync(join(powershellHome, 'powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    {input: JSON.stringify(paths), env, encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 8192});
  assert.equal(result.status, 0, 'QA_PRIVATE_FIXTURE_ACL_FAILED ' + String(result.stderr ?? '').slice(0, 512));
}
