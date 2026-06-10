#!/usr/bin/env pwsh
# ──────────────────────────────────────────────
#  bump.ps1 — Cache buster automatico
#
#  Uso:
#    .\bump.ps1            (incrementa de 1)
#    .\bump.ps1 -To 200    (forca pra 200)
#
#  CRITICO: usa [System.IO.File] direto com encoding UTF-8 explicito
#  pra NAO destruir caracteres especiais (é, ã, ç) do HTML.
#
#  Bug anterior: Get-Content + Set-Content do PS 5.1 leu UTF-8 como
#  Windows-1252 e reescreveu como UTF-8 — virou mojibake (Métodos -> MÃ©todos).
# ──────────────────────────────────────────────

param(
  [int]$To = 0
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$versionFile = Join-Path $root 'version.txt'
# HTMLs que carregam assets versionados (?v=NUM)
$htmlFiles = @(
  (Join-Path $root 'index.html'),
  (Join-Path $root 'landing\index.html')
)

if (-not (Test-Path $versionFile)){
  [System.IO.File]::WriteAllText($versionFile, '100', (New-Object System.Text.UTF8Encoding $false))
}

$current = [int]([System.IO.File]::ReadAllText($versionFile, [System.Text.Encoding]::UTF8)).Trim()
$new = if ($To -gt 0) { $To } else { $current + 1 }

[System.IO.File]::WriteAllText($versionFile, "$new", (New-Object System.Text.UTF8Encoding $false))

$pattern = '(?<=(?:[\w-]+\.(?:js|css))\?v=)\d+'

foreach ($file in $htmlFiles){
  if (-not (Test-Path $file)) { continue }
  $bytes = [System.IO.File]::ReadAllBytes($file)
  $hasBom = ($bytes.Length -ge 3) -and ($bytes[0] -eq 0xEF) -and ($bytes[1] -eq 0xBB) -and ($bytes[2] -eq 0xBF)
  $html = [System.IO.File]::ReadAllText($file, [System.Text.Encoding]::UTF8)
  $html = [regex]::Replace($html, $pattern, "$new")
  $encoding = New-Object System.Text.UTF8Encoding $hasBom
  [System.IO.File]::WriteAllText($file, $html, $encoding)
  $rel = $file.Replace($root + '\', '').Replace($root + '/', '')
  Write-Host "  - $rel (BOM: $hasBom)" -ForegroundColor Cyan
}

Write-Host "Version bump: $current -> $new" -ForegroundColor Green
