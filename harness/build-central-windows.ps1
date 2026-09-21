# SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
# P0 qualification build, not an installed or enabled Windows central runtime.
param(
    [Parameter(Mandatory = $true)][string]$BuildDirectory,
    [string]$Toolchain = 'stable',
    [int]$Jobs = 2,
    [switch]$Resume,
    [switch]$RefreshModelOverlay
)
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'Windows PowerShell 7 host required' }
if ($Jobs -lt 1 -or $Jobs -gt 8) { throw 'Jobs must be 1..8' }
if ($RefreshModelOverlay -and -not $Resume) { throw 'Model overlay refresh requires a recorded build and -Resume' }
$buildRoot = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($BuildDirectory)
$pin = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'upstream.json') -Raw | ConvertFrom-Json
if (-not $Resume) {
    if (Test-Path -LiteralPath $buildRoot) { throw 'Use a new directory, or explicitly resume a recorded build' }
    New-Item -ItemType Directory -Path $buildRoot | Out-Null
}
# An OS file lease distinguishes a live build from a process killed before its
# finally block. The file may remain; only the exclusive open indicates activity.
$lease = [IO.File]::Open((Join-Path $buildRoot 'build.lock'), [IO.FileMode]::OpenOrCreate,
    [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
$resultPath = Join-Path $buildRoot 'build-result.json'
function Write-BuildRecord($Value, [string]$Path = $resultPath) {
    $temporary = "$Path.$([guid]::NewGuid()).tmp"
    [IO.File]::WriteAllText($temporary, (($Value | ConvertTo-Json -Depth 8) + "`n"), [Text.UTF8Encoding]::new($false))
    if ([IO.File]::Exists($Path)) { [IO.File]::Replace($temporary, $Path, [NullString]::Value) }
    else { [IO.File]::Move($temporary, $Path) }
}
$record = $null
$previousEnvironment = @{}
$environmentChanged = $false
try {
    $prior = $null
    if ($Resume) {
        $prior = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
        if ($prior.commit -ne $pin.commit -or $prior.patchSha256 -ne $pin.patch.sha256 -or $prior.platform -ne 'win32' -or
            ($prior.windowsPatchSha256 -and $prior.windowsPatchSha256 -ne $pin.windowsPatch.sha256) -or
            ($prior.windowsModelPatchSha256 -and $prior.windowsModelPatchSha256 -ne $pin.windowsModelPatch.sha256 -and -not $RefreshModelOverlay)) {
            throw 'Resume manifest does not match the pinned Windows build'
        }
        if ($prior.status -in @('preparing', 'building')) {
            $prior | Add-Member -NotePropertyName interruptedPhase -NotePropertyValue $prior.status -Force
            $prior.status = 'interrupted'
            $prior | Add-Member -NotePropertyName error -NotePropertyValue 'Previous process ended without recording a terminal state' -Force
        }
        Write-BuildRecord $prior (Join-Path $buildRoot "build-result-$([guid]::NewGuid()).json")
    }
    $record = [ordered]@{
        schemaVersion = 4; platform = 'win32'; commit = $pin.commit; patchSha256 = $pin.patch.sha256
        windowsPatchSha256 = $pin.windowsPatch.sha256
        windowsModelPatchSha256 = $pin.windowsModelPatch.sha256
        modelOverlayRefreshRequested = [bool]$RefreshModelOverlay
        attemptId = [guid]::NewGuid().ToString(); startedAt = [DateTime]::UtcNow.ToString('o')
        updatedAt = $null; finishedAt = $null; completionRecorded = $false
        resumedFrom = $(if ($prior) { [ordered]@{ attemptId = $prior.attemptId; status = $prior.status; windowsPatchSha256 = $prior.windowsPatchSha256; windowsModelPatchSha256 = $prior.windowsModelPatchSha256 } } else { $null })
        toolchain = $Toolchain; compiler = $null; compilerDetails = $null; target = $null
        processArchitecture = [Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture.ToString()
        preparedLockSha256 = $null; preparedLockHashNormalization = 'UTF-8 CRLF normalized to LF'
        toolchainQualification = 'Development selector; actual compiler recorded, fixed compiler qualification pending'
        status = 'preparing'; deployable = $false; binary = $null; binarySha256 = $null
        licenseMaterialization = 'bubblewrap/LICENSE is a byte copy of COPYING'
    }
    $record.updatedAt = [DateTime]::UtcNow.ToString('o')
    Write-BuildRecord $record
    # Refuse compiler/configuration overrides rather than silently accepting a
    # different compiler or replacing the upstream Windows CRT/link settings.
    $overrides = @(Get-ChildItem Env: | Where-Object {
        $_.Name -match '^(RUSTC|RUSTDOC|RUSTFLAGS|RUSTDOCFLAGS|RUSTC_WRAPPER|RUSTC_WORKSPACE_WRAPPER|CARGO_ENCODED_RUSTFLAGS|CARGO_ENCODED_RUSTDOCFLAGS|CARGO_BUILD_RUSTC|CARGO_BUILD_RUSTC_WRAPPER|CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER|CARGO_BUILD_RUSTFLAGS|CARGO_BUILD_TARGET)$' -or
        $_.Name -match '^CARGO_TARGET_.*_(RUSTFLAGS|LINKER|RUNNER)$' -or $_.Name -match '^CARGO_PROFILE_'
    })
    if ($overrides.Count) { throw "Unsupported inherited compiler overrides: $($overrides.Name -join ', ')" }
    $record.compilerDetails = @(& rustc "+$Toolchain" -vV)
    if ($LASTEXITCODE -ne 0) { throw 'Cannot identify requested Rust compiler' }
    $record.compiler = $record.compilerDetails[0]
    $hostLine = @($record.compilerDetails | Where-Object { $_ -match '^host: ' })
    if ($hostLine.Count -ne 1) { throw 'Cannot identify compiler host target' }
    $record.target = $hostLine[0].Substring(6).Trim()
    $managedNames = @('CARGO_TARGET_DIR', 'CARGO_HOME', 'CARGO_NET_GIT_FETCH_WITH_CLI', 'CARGO_PROFILE_DEV_DEBUG',
        'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_TERMINAL_PROMPT')
    $gitNames = @((Get-ChildItem Env: | Where-Object Name -Match '^GIT_').Name)
    foreach ($name in @($managedNames + $gitNames | Select-Object -Unique)) {
        $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
    }
    $environmentChanged = $true
    # Remove inherited Git repository context, dynamic config, credentials and
    # TLS overrides. Only this process is changed; finally restores every value.
    foreach ($name in $gitNames) { [Environment]::SetEnvironmentVariable($name, [NullString]::Value, 'Process') }
    $env:CARGO_HOME = Join-Path $buildRoot 'cargo'
    $env:GIT_CONFIG_GLOBAL = Join-Path $buildRoot 'public-build.gitconfig'
    # Certificate verification stays enabled; no interactive credential helpers.
    Set-Content -LiteralPath $env:GIT_CONFIG_GLOBAL -Value "[http]`n    sslBackend = openssl`n    sslVerify = true`n[core]`n    longpaths = true" -Encoding utf8
    $env:GIT_CONFIG_NOSYSTEM = '1'
    $env:GIT_TERMINAL_PROMPT = '0'
    $env:CARGO_NET_GIT_FETCH_WITH_CLI = 'true'
    $env:CARGO_TARGET_DIR = Join-Path $buildRoot 'target'
    $env:CARGO_PROFILE_DEV_DEBUG = '0'
    $sourceRoot = Join-Path $buildRoot "source/codex-$($pin.commit)"
    if ($Resume) {
        & node (Join-Path $PSScriptRoot 'prepare-patch.mjs') $sourceRoot --verify *> (Join-Path $buildRoot "resume-prepare-$($record.attemptId).log")
        if ($LASTEXITCODE -ne 0) { throw 'Prepared source verification failed; see resume-prepare log. Use a new directory if source preparation was interrupted.' }
    } else {
        & node (Join-Path $PSScriptRoot 'fetch-source.mjs') (Join-Path $buildRoot 'source') *> (Join-Path $buildRoot 'prepare.log')
        if ($LASTEXITCODE -ne 0) { throw 'SOURCE_PREPARATION_FAILED: see prepare.log' }
    }
    $sourceFiles = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'source-files.json') -Raw | ConvertFrom-Json
    $record.preparedLockSha256 = ($sourceFiles | Where-Object path -EQ 'codex-rs/Cargo.lock').patchedSha256
    if (-not $record.preparedLockSha256) { throw 'Missing verified lockfile hash' }
    $record.status = 'building'
    $record.updatedAt = [DateTime]::UtcNow.ToString('o')
    Write-BuildRecord $record
    $manifest = Join-Path $sourceRoot 'codex-rs/Cargo.toml'
    # Enter the upstream workspace so its Windows CRT/link settings are applied.
    Push-Location (Split-Path $manifest)
    try {
        if (Test-Path -LiteralPath (Join-Path $buildRoot 'build.log')) {
            Copy-Item -LiteralPath (Join-Path $buildRoot 'build.log') -Destination (Join-Path $buildRoot "build-$([guid]::NewGuid()).log")
        }
        & cargo "+$Toolchain" build --locked -p codex-app-server --bin codex-app-server -j $Jobs *> (Join-Path $buildRoot 'build.log')
        if ($LASTEXITCODE -ne 0) { throw 'WINDOWS_HARNESS_BUILD_FAILED: see build.log' }
    } finally { Pop-Location }
    $record.binary = Join-Path $env:CARGO_TARGET_DIR 'debug/codex-app-server.exe'
    $record.binarySha256 = (Get-FileHash -LiteralPath $record.binary -Algorithm SHA256).Hash.ToLowerInvariant()
    $record.status = 'built-not-runtime-qualified'
} catch {
    if ($record) {
        $record.status = 'failed'
        $record.error = $_.Exception.Message
    }
    throw
} finally {
    try {
        if ($environmentChanged) {
            foreach ($name in $previousEnvironment.Keys) {
                if ($null -eq $previousEnvironment[$name]) {
                    [Environment]::SetEnvironmentVariable($name, [NullString]::Value, 'Process')
                } else {
                    [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], 'Process')
                }
            }
        }
        if ($record) {
            if ($record.status -in @('preparing', 'building')) { $record.status = 'interrupted' }
            $record.completionRecorded = $true
            $record.finishedAt = [DateTime]::UtcNow.ToString('o')
            $record.updatedAt = $record.finishedAt
            Write-BuildRecord $record
        }
    } finally { $lease.Dispose() }
}
