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
$indexFile   = Join-Path $root 'index.html'

if (-not (Test-Path $versionFile)){
  [System.IO.File]::WriteAllText($versionFile, '100', (New-Object System.Text.UTF8Encoding $false))
}

$current = [int]([System.IO.File]::ReadAllText($versionFile, [System.Text.Encoding]::UTF8)).Trim()
$new = if ($To -gt 0) { $To } else { $current + 1 }

# Atualiza version.txt (UTF-8 sem BOM)
[System.IO.File]::WriteAllText($versionFile, "$new", (New-Object System.Text.UTF8Encoding $false))

# Atualiza index.html — qualquer ?v=NUM nos assets locais (.js/.css)
# IMPORTANTE: detecta se tem BOM no original e preserva
$bytes = [System.IO.File]::ReadAllBytes($indexFile)
$hasBom = ($bytes.Length -ge 3) -and ($bytes[0] -eq 0xEF) -and ($bytes[1] -eq 0xBB) -and ($bytes[2] -eq 0xBF)

$html = [System.IO.File]::ReadAllText($indexFile, [System.Text.Encoding]::UTF8)
$pattern = '(?<=(?:[\w-]+\.(?:js|css))\?v=)\d+'
$html = [regex]::Replace($html, $pattern, "$new")

# Reescreve com mesmo BOM/no-BOM do original
$encoding = New-Object System.Text.UTF8Encoding $hasBom
[System.IO.File]::WriteAllText($indexFile, $html, $encoding)

Write-Host "Version bump: $current -> $new" -ForegroundColor Green
Write-Host "Atualizado em index.html (BOM: $hasBom)" -ForegroundColor Cyan
