# Allow inbound SSH to the WSL GPU runner (kangaroo) in mirrored networking mode.
#
# WSL2 mirrored mode shares the Windows host IPs, so the observatory reaches the
# WSL sshd directly on the host's Tailscale / LAN address -- but inbound is gated
# by the WSL *Hyper-V* firewall (DefaultInboundAction=Block) plus the standard
# Windows Firewall. This opens TCP 22 through both, scoped to Tailscale CGNAT
# (100.64.0.0/10) and the local LAN. sshd itself is key-only (see WSL config).
#
# Must run ELEVATED. Idempotent: re-running replaces the rules.
#   Right-click > Run with PowerShell (as admin), or:
#   Start-Process powershell -Verb RunAs -ArgumentList '-File scripts\gpu-runner-firewall.ps1'
#
# Docs: docs/KANGAROO-GPU.md (Windows / WSL GPU runner)

$ErrorActionPreference = 'Stop'
$log = Join-Path $env:TEMP 'ss-gpu-firewall.log'
Start-Transcript -Path $log -Force | Out-Null

$port      = 22
$name      = 'SatoshiSearch GPU Runner SSH (WSL)'
$hvName    = 'SS-GPU-Runner-SSH'
$wslVmId   = '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}'   # well-known WSL VMCreatorId
$remotes   = @('100.64.0.0/10', '192.168.0.0/16')       # Tailscale CGNAT + private LAN

Write-Host "== Standard Windows Firewall inbound rule =="
Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
New-NetFirewallRule -DisplayName $name -Direction Inbound -Action Allow -Protocol TCP `
    -LocalPort $port -RemoteAddress $remotes -Profile Any -Enabled True | Out-Null
Write-Host "  created: $name (TCP $port from $($remotes -join ', '))"

Write-Host "== WSL Hyper-V firewall inbound rule =="
Remove-NetFirewallHyperVRule -Name $hvName -ErrorAction SilentlyContinue
New-NetFirewallHyperVRule -Name $hvName -DisplayName $name -Direction Inbound -Action Allow `
    -Protocol TCP -LocalPorts $port -RemoteAddresses $remotes -VMCreatorId $wslVmId -Enabled True | Out-Null
Write-Host "  created: $hvName on VM $wslVmId (TCP $port)"

Write-Host "== Verify =="
Get-NetFirewallRule -DisplayName $name | Select-Object DisplayName, Direction, Action, Enabled | Format-Table -AutoSize
Get-NetFirewallHyperVRule -Name $hvName | Select-Object Name, Direction, Action, Enabled | Format-Table -AutoSize

Write-Host "DONE"
Stop-Transcript | Out-Null
