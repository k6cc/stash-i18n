<#
.SYNOPSIS
  汉化插件上游增量查看 / 基线记账工具。

.DESCRIPTION
  读取仓库根 UPSTREAM.md 的记账表，按插件给出「自上次同步基线以来的上游增量」。

  用法：
    # 1) 拉取上游最新（按记账表里的上游仓库自动解析/添加 remote）
    pwsh -NoProfile -File scripts/upstream-diff.ps1 -Fetch

    # 2) 列出全部插件的上游状态（基线 / 上游 HEAD / 落后提交数）
    pwsh -NoProfile -File scripts/upstream-diff.ps1

    # 3) 只看某个插件的上游增量（提交列表 + diffstat + 完整 diff）
    pwsh -NoProfile -File scripts/upstream-diff.ps1 -Plugin oStatsI18n

    # 4) 同步完成后把该插件基线推进到上游 HEAD（或 -Base 指定 sha）
    pwsh -NoProfile -File scripts/upstream-diff.ps1 -Plugin oStatsI18n -Record

  说明：-Plugin 名称即 UPSTREAM.md 记账表的插件列（= 插件目录名）。
#>
[CmdletBinding()]
param(
  [string]$Plugin,
  [switch]$Fetch,
  [switch]$Record,
  [string]$Base
)

$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$UpstreamMd = Join-Path $Root 'UPSTREAM.md'

if (-not (Test-Path $UpstreamMd)) {
  throw "找不到 $UpstreamMd —— 请先在本目录建好上游记账表"
}

function Invoke-Git {
  param([string[]]$GitArgs)
  # git 的进度信息走 stderr（如 fetch 的 "From <url>"），EAP=Stop 下会被当成
  # 终止性错误抛出，这里临时降级为 Continue，统一用退出码判断成败。
  $oldEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $out = & git @GitArgs 2>&1
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $oldEap
  }
  $text = ($out | Out-String).Trim()
  if ($code -ne 0) {
    throw ("git {0} failed: {1}" -f ($GitArgs -join ' '), $text)
  }
  return $text
}

# --- 解析 UPSTREAM.md 记账表 ------------------------------------------------
# 行格式：| 插件 | 上游仓库链接 | `路径` | License | `base` | 日期 |
function Get-UpstreamRecords {
  $records = @()
  $inTable = $false
  foreach ($line in (Get-Content -LiteralPath $UpstreamMd -Encoding UTF8)) {
    if ($line -match '^\s*\|\s*插件\s*\|') { $inTable = $true; continue }
    if ($line -match '^\s*\|[-:\s|]+\|\s*$') { continue }   # 分隔行
    if ($inTable) {
      if ($line -notmatch '^\s*\|') { continue }
      $cells = $line.Trim().Trim('|') -split '\|'
      if ($cells.Count -lt 6) { continue }
      $id = $cells[0].Trim()
      if ([string]::IsNullOrWhiteSpace($id)) { continue }
      $repoMatch = [regex]::Match($cells[1], '\((https?://[^)]+)\)')
      $repoUrl = if ($repoMatch.Success) { $repoMatch.Groups[1].Value } else { '' }
      # 上游仓库列也可能直接是 owner/repo 纯文本
      if (-not $repoUrl) {
        $plain = $cells[1].Trim()
        if ($plain -match '^[\w.-]+/[\w.-]+$') { $repoUrl = "https://github.com/$plain.git" }
      }
      $records += [pscustomobject]@{
        Id       = $id
        RepoUrl  = $repoUrl
        Path     = ($cells[2].Trim().Trim('`'))
        License  = $cells[3].Trim()
        Base     = ($cells[4].Trim().Trim('`'))
        Date     = $cells[5].Trim()
      }
    }
  }
  return $records
}

# --- 按插件上游仓库解析 remote（不存在则添加） ------------------------------
function Resolve-UpstreamRemote {
  param([string]$RepoUrl)
  $want = $RepoUrl.ToLowerInvariant() -replace '\.git$', ''
  $lines = (& git remote -v 2>$null)
  foreach ($line in $lines) {
    $parts = ($line -split '\s+')
    if ($parts.Count -ge 2) {
      $url = $parts[1].ToLowerInvariant() -replace '\.git$', ''
      if ($url -eq $want) { return $parts[0] }
    }
  }
  # 未关联过：按 owner-repo 命名新增只读 remote
  # 先剥掉 scheme+host（GitHub / GitLab 通用），再把路径分隔符压成 -，得到
  # upstream-<owner>-<repo>。若只剥 github.com，GitLab 地址会变成
  # upstream-https---gitlab.com-<owner>-<repo> 这种丑名字。
  $slug = ($want -replace '^https?://[^/]+/', '' -replace '[^\w.-]', '-')
  $name = "upstream-$slug"
  Write-Host "[remote] 新增 $name -> $RepoUrl" -ForegroundColor DarkGray
  Invoke-Git @('remote', 'add', $name, $RepoUrl) | Out-Null
  return $name
}

# --- 更新 UPSTREAM.md 记账表的某一行 ----------------------------------------
function Set-Baseline {
  param([string]$Id, [string]$Sha, [string]$Date)
  $text = [IO.File]::ReadAllText($UpstreamMd)
  $nl = if ($text -match "`r`n") { "`r`n" } else { "`n" }
  $lines = $text -split "`r?`n"
  $hit = $false
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -notmatch '^\s*\|') { continue }
    $cells = $lines[$i].Trim().Trim('|') -split '\|'
    if ($cells.Count -lt 6) { continue }
    if ($cells[0].Trim() -ne $Id) { continue }
    # 保留原有空格排版：cell0..cell4 原样，替换 cell4(base) 与 cell5(date)
    $cells[4] = " ``$Sha`` "
    $cells[5] = " $Date "
    $lines[$i] = '|' + ($cells -join '|') + '|'
    $hit = $true
    break
  }
  if (-not $hit) { throw "UPSTREAM.md 记账表中找不到插件 '$Id' 的行" }
  $out = ($lines -join $nl)
  if (-not $out.EndsWith($nl)) { $out += $nl }
  [IO.File]::WriteAllText($UpstreamMd, $out, (New-Object Text.UTF8Encoding $false))
}

# --- 主流程 -----------------------------------------------------------------
$records = Get-UpstreamRecords
if ($records.Count -eq 0) { throw 'UPSTREAM.md 记账表为空' }

if ($Fetch) {
  $repos = $records | Where-Object { $_.RepoUrl } | Select-Object -ExpandProperty RepoUrl -Unique
  foreach ($repo in $repos) {
    $remote = Resolve-UpstreamRemote $repo
    Write-Host "[fetch] $remote ..." -ForegroundColor Cyan
    Invoke-Git @('fetch', $remote, 'main', '--prune') | Out-Null
  }
  Write-Host ''
}

$targets = if ($Plugin) {
  $r = $records | Where-Object { $_.Id -eq $Plugin }
  if (-not $r) { throw "UPSTREAM.md 记账表中找不到插件 '$Plugin'。已知：$(($records.Id) -join ', ')" }
  $r
} else { $records }

foreach ($rec in $targets) {
  if (-not $rec.RepoUrl) { Write-Host "[$($rec.Id)] 记账表缺少上游仓库地址，跳过" -ForegroundColor Yellow; continue }
  $remote = Resolve-UpstreamRemote $rec.RepoUrl

  $baseline = if ($Base) { $Base } else { $rec.Base }
  if ([string]::IsNullOrWhiteSpace($baseline)) { Write-Host "[$($rec.Id)] 记账表缺少基线 SHA，跳过" -ForegroundColor Yellow; continue }

  $head = Invoke-Git @('log', '-1', '--format=%H', "$remote/main", '--', $rec.Path)
  if ([string]::IsNullOrWhiteSpace($head)) {
    Write-Host "[$($rec.Id)] 上游 $remote/main 上找不到路径 $($rec.Path)" -ForegroundColor Yellow
    continue
  }
  $headShort = $head.Substring(0, 7)

  if ($Record) {
    $newBase = if ($Base) { $Base } else { $headShort }
        $today = Get-Date -Format 'yyyy-MM-dd'
    Set-Baseline -Id $rec.Id -Sha $newBase -Date $today
    Write-Host "[$($rec.Id)] 基线已记录：$($rec.Base) -> $newBase ($today)" -ForegroundColor Green
    continue
  }

  Write-Host ("=" * 72)
  Write-Host "[$($rec.Id)]  上游 $($rec.RepoUrl)  路径 $($rec.Path)"
  Write-Host "  基线 base    : $($rec.Base) ($($rec.Date))"
  Write-Host "  上游 HEAD    : $headShort"
  Write-Host ("=" * 72)

  # 基线是否为上游可达 commit（exit 1 = 不是祖先，属预期分支，不能抛错）
  & git merge-base --is-ancestor $baseline "$remote/main" 2>$null
  $isAncestor = ($LASTEXITCODE -eq 0)
  $log = & git log --oneline "$baseline..$remote/main" -- $rec.Path 2>&1
  if (-not $isAncestor) {
    Write-Host "  ⚠ 基线 $baseline 不是 $remote/main 的祖先（上游可能改写了历史），请核对记账表" -ForegroundColor Yellow
    Write-Host (($log | Out-String).Trim())
    Write-Host ''
    continue
  }
  if ([string]::IsNullOrWhiteSpace(($log | Out-String).Trim())) {
    Write-Host '  ✔ 已是最新（基线之后该路径无上游提交）' -ForegroundColor Green
    Write-Host ''
    continue
  }

  Write-Host ''
  Write-Host '--- 上游新提交 ---' -ForegroundColor Cyan
  Write-Host (($log | Out-String).Trim())
  Write-Host ''
  Write-Host '--- 变更统计 ---' -ForegroundColor Cyan
  Write-Host (& git diff --stat "$baseline..$remote/main" -- $rec.Path | Out-String).Trim()

  if ($Plugin) {
    Write-Host ''
    Write-Host '--- 完整 diff ---' -ForegroundColor Cyan
    Write-Host (& git diff "$baseline..$remote/main" -- $rec.Path | Out-String).Trim()
    Write-Host ''
  } else {
    Write-Host '  （加 -Plugin <名称> 查看该插件的完整 diff）' -ForegroundColor DarkGray
    Write-Host ''
  }
}
