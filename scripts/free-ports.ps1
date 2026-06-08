param(
  [string[]]$Ports = @("5173", "3847"),
  [int]$WaitSeconds = 10
)

$ErrorActionPreference = "Stop"
$TargetPorts = @(
  $Ports |
    ForEach-Object { $_ -split "," } |
    Where-Object { $_.Trim() } |
    ForEach-Object { [int]$_.Trim() }
)

function Get-ListeningProcessIds {
  param([int[]]$TargetPorts)

  Get-NetTCPConnection -LocalPort $TargetPorts -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $_.OwningProcess -gt 0 } |
    Select-Object -ExpandProperty OwningProcess -Unique
}

$processIds = @(Get-ListeningProcessIds -TargetPorts $TargetPorts)

foreach ($processId in $processIds) {
  $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
  if (-not $process) { continue }

  Write-Host ("  Stopping stale listener {0} (PID {1})..." -f $process.ProcessName, $processId)
  & "$env:SystemRoot\System32\taskkill.exe" /PID $processId /T /F | Out-Null
}

$deadline = (Get-Date).AddSeconds($WaitSeconds)
do {
  $remaining = @(Get-ListeningProcessIds -TargetPorts $TargetPorts)
  if ($remaining.Count -eq 0) {
    exit 0
  }
  Start-Sleep -Milliseconds 250
} while ((Get-Date) -lt $deadline)

foreach ($processId in $remaining) {
  $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
  if ($process) {
    Write-Host ("  [ERROR] Port still in use by {0} (PID {1})." -f $process.ProcessName, $processId)
  } else {
    Write-Host ("  [ERROR] Port still in use by PID {0}." -f $processId)
  }
}

exit 1
