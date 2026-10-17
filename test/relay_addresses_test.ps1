$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../deploy/relay/relay-addresses.ps1')
$configs = @(
    [pscustomobject]@{ InterfaceAlias = 'Karing TUN'; NetAdapter = @{ Status = 'Up'; HardwareInterface = $false; Virtual = $true }; IPv4Address = @(@{ IPAddress = '198.18.0.1' }) },
    [pscustomobject]@{ InterfaceAlias = 'Wi-Fi'; NetAdapter = @{ Status = 'Up'; HardwareInterface = $true; Virtual = $false }; IPv4Address = @(@{ IPAddress = '192.168.1.20' }) },
    [pscustomobject]@{ InterfaceAlias = 'Ethernet'; NetAdapter = @{ Status = 'Disconnected'; HardwareInterface = $true }; IPv4Address = @(@{ IPAddress = '10.0.0.5' }) },
    [pscustomobject]@{ InterfaceAlias = 'Loopback'; NetAdapter = @{ Status = 'Up'; HardwareInterface = $false }; IPv4Address = @(@{ IPAddress = '127.0.0.1' }) }
)
$candidates = @(Get-RelayAddressCandidates -Configurations $configs)
if ($candidates.Count -ne 2 -or $candidates[0].Address -ne '192.168.1.20' -or -not $candidates[0].Physical -or $candidates[1].Address -ne '198.18.0.1') { throw 'Physical LAN recommendation / VPN inventory failed.' }
if (@(Get-RelayAddressCandidates -Configurations @()).Count -ne 0) { throw 'Empty adapter inventory failed.' }
Write-Output 'PASS: physical LAN recommended before Karing TUN; inactive and loopback addresses excluded.'
