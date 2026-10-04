# 把插件同步到 otools 仓库的 plugins 目录
# 用法：pwsh -File scripts/deploy-to-otools.ps1 [-OtoolsRoot "D:\Repos\xyito\otools\otools"]
param(
  [string]$OtoolsRoot = "D:\Repos\xyito\otools\otools"
)

$ErrorActionPreference = "Stop"
$pluginRoot = Split-Path -Parent $PSScriptRoot
$target = Join-Path $OtoolsRoot "plugins\otools-compositor"

if (-not (Test-Path (Join-Path $OtoolsRoot "scripts\otools-plugin-vite-config-sdk.ts"))) {
  Write-Error "未找到 otools 仓库：$OtoolsRoot（可用 -OtoolsRoot 指定其它路径）"
}

if (Test-Path $target) {
  Remove-Item -LiteralPath $target -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $target | Out-Null

# 复制源码与构建产物（排除 .git 与 node_modules）
$exclude = @(".git", "node_modules", "dist", "docs")
Get-ChildItem -LiteralPath $pluginRoot -Force | Where-Object { $exclude -notcontains $_.Name } | ForEach-Object {
  Copy-Item -LiteralPath $_.FullName -Destination $target -Recurse -Force
}
if (Test-Path (Join-Path $pluginRoot "docs")) {
  Copy-Item -LiteralPath (Join-Path $pluginRoot "docs") -Destination $target -Recurse -Force
}
if (Test-Path (Join-Path $pluginRoot "dist")) {
  Copy-Item -LiteralPath (Join-Path $pluginRoot "dist") -Destination $target -Recurse -Force
}

Write-Host "已同步到 $target"
Write-Host "在 otools 中执行：pnpm --dir $target install ; pnpm --dir $target build"
