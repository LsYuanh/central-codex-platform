# SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
[CmdletBinding()]
param([string]$OutDirectory = '')
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$centralHostProject = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if ([string]::IsNullOrWhiteSpace($OutDirectory)) {
    $OutDirectory = Join-Path $centralHostProject 'target/windows-worker-host'
}
$centralHostOutput = [IO.Path]::GetFullPath($OutDirectory)
if (-not $centralHostOutput.StartsWith($centralHostProject + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Worker host output must stay inside spikes/local-dev.'
}
if (-not (Get-Command cl.exe -ErrorAction SilentlyContinue)) {
    $centralHostVsWhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
    if (-not (Test-Path -LiteralPath $centralHostVsWhere)) { throw 'MSVC Build Tools with the Windows SDK are required.' }
    $centralHostVsRoot = & $centralHostVsWhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if (-not $centralHostVsRoot) { throw 'MSVC x64 compiler was not found.' }
    $centralHostDevCmd = Join-Path $centralHostVsRoot 'Common7/Tools/VsDevCmd.bat'
    # Capture the developer environment without printing existing process variables.
    $centralHostEnvironment = & $env:ComSpec /d /s /c "`"$centralHostDevCmd`" -no_logo -arch=x64 -host_arch=x64 >nul && set"
    if ($LASTEXITCODE -ne 0) { throw 'Unable to initialize the MSVC developer environment.' }
    foreach ($centralHostLine in $centralHostEnvironment) {
        $centralHostSeparator = $centralHostLine.IndexOf('=')
        if ($centralHostSeparator -gt 0) {
            [Environment]::SetEnvironmentVariable($centralHostLine.Substring(0, $centralHostSeparator), $centralHostLine.Substring($centralHostSeparator + 1), 'Process')
        }
    }
}
New-Item -ItemType Directory -Force -Path $centralHostOutput | Out-Null
$centralHostSource = Join-Path $centralHostProject 'services/windows-worker-host/main.cpp'
$centralHostExecutable = Join-Path $centralHostOutput 'windows-worker-host.exe'
$centralHostObject = Join-Path $centralHostOutput 'windows-worker-host.obj'
$centralHostPdb = Join-Path $centralHostOutput 'windows-worker-host.pdb'
& cl.exe /nologo /std:c++17 /EHsc /W4 /O2 /MT /DUNICODE /D_UNICODE /D_WIN32_WINNT=0x0A00 "/Fo:$centralHostObject" "/Fe:$centralHostExecutable" $centralHostSource /link "/PDB:$centralHostPdb" /SUBSYSTEM:CONSOLE
if ($LASTEXITCODE -ne 0) { throw 'Windows Worker host compilation failed.' }
$centralHostHash = (Get-FileHash -LiteralPath $centralHostExecutable -Algorithm SHA256).Hash.ToLowerInvariant()
[pscustomobject]@{ executable = $centralHostExecutable; sha256 = $centralHostHash; qualified = $false } | ConvertTo-Json
