#Requires -Version 7.4
param([switch]$Stop)
$ErrorActionPreference = 'Stop'
$libraryRoot = Split-Path $PSScriptRoot -Parent
$catalog = Get-Content -LiteralPath (Join-Path $libraryRoot 'catalog.json') -Raw | ConvertFrom-Json
foreach ($entry in $catalog.packages) {
  if ($entry.path -notmatch '^studios/[a-z][a-z0-9-]*$') { continue }
  $manifest = Get-Content -LiteralPath (Join-Path $libraryRoot ($entry.path + '/studio.json')) -Raw | ConvertFrom-Json
  if (-not $manifest.service.windows) { continue }
  $relative = [string]$manifest.service.windows
  if ($relative -notmatch '^scripts/[a-z][a-z0-9-]*\.ps1$') { throw '服务启动脚本必须位于工作库 scripts 目录。' }
  & (Join-Path (Join-Path $libraryRoot $entry.path) $relative) -Stop:$Stop
}
