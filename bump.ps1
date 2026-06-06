#!/usr/bin/env pwsh
# ──────────────────────────────────────────────
#  bump.ps1 — Cache buster automatico
#
#  Uso:
#    .\bump.ps1            (incrementa de 1)
#    .\bump.ps1 -To 200    (forca pra 200)
#
#  O que faz:
#    1) Le version.txt
#    2) Incrementa +1 (ou usa -To)
#    3) Escreve em version.txt
#    4) Atualiza TODOS os ?v=X em index.html (script.js, style.css, config.js)
#    5) Mostra resumo
#
#  Substitui o trabalho manual de procurar "v=158" e mudar pra "v=159"
#  em 3 lugares do HTML toda vez que mexe em CSS/JS.
# ──────────────────────────────────────────────

param(
  [int]$To = 0
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$versionFile = Join-Path $root 'version.txt'
$indexFile   = Join-Path $root 'index.html'

if (-not (Test-Path $versionFile)){ Set-Content $versionFile -Value '100' -Encoding utf8 -NoNewline }

$current = [int](Get-Content $versionFile -Raw).Trim()
$new = if ($To -gt 0) { $To } else { $current + 1 }

# Atualiza version.txt
Set-Content $versionFile -Value "$new" -Encoding utf8 -NoNewline

# Atualiza index.html — qualquer ?v=NUM nos assets
$html = Get-Content $indexFile -Raw
$pattern = '(?<=(?:script\.js|style\.css|config\.js)\?v=)\d+'
$html = [regex]::Replace($html, $pattern, "$new")
Set-Content $indexFile -Value $html -Encoding utf8 -NoNewline

Write-Host "Version bump: $current -> $new" -ForegroundColor Green
Write-Host "Atualizado em index.html" -ForegroundColor Cyan
