# SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

$ErrorActionPreference = "Stop"
$spikeRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$envFile = Join-Path $spikeRoot ".env"
$exampleFile = Join-Path $spikeRoot ".env.example"
$dataDirectory = Join-Path $spikeRoot "data"

if (-not (Test-Path -LiteralPath $envFile)) {
    Copy-Item -LiteralPath $exampleFile -Destination $envFile
    Write-Output "Created $envFile"
} else {
    Write-Output "Keeping existing $envFile"
}

New-Item -ItemType Directory -Force -Path $dataDirectory | Out-Null
Write-Output "SQLite data directory ready: $dataDirectory"
