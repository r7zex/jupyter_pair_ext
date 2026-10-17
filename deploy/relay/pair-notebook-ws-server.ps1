param([switch]$SmokeTest, [string]$DataDirectory, [string]$Address, [int]$Port = 8787)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
. (Join-Path $PSScriptRoot 'relay-addresses.ps1')
if (-not $DataDirectory) { $DataDirectory = Join-Path $PSScriptRoot 'server' }
$DataDirectory = [IO.Path]::GetFullPath($DataDirectory)
New-Item -ItemType Directory -Path $DataDirectory -Force | Out-Null
$settingsFile = Join-Path $DataDirectory 'settings.json'
$script:relay = $null
$script:settings = $null
$script:node = $null

function Get-NodeRuntime {
    $command = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($command -and [int]((& $command.Source --version).TrimStart('v').Split('.')[0]) -ge 20) { return $command.Source }
    $runtime = Join-Path $DataDirectory 'runtime'
    $binary = Join-Path $runtime 'node.exe'
    if (Test-Path -LiteralPath $binary) { return $binary }
    $version = '22.22.2'
    $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
    $name = "node-v$version-win-$arch.zip"
    $download = Join-Path ([IO.Path]::GetTempPath()) ('pair-relay-download-' + [guid]::NewGuid())
    New-Item -ItemType Directory -Path $download | Out-Null
    try {
        Invoke-WebRequest -UseBasicParsing "https://nodejs.org/dist/v$version/$name" -OutFile (Join-Path $download $name)
        $sums = (Invoke-WebRequest -UseBasicParsing "https://nodejs.org/dist/v$version/SHASUMS256.txt").Content
        $expected = (($sums -split "`n" | Where-Object { $_.Trim().EndsWith(" $name") }) -split '\s+')[0]
        if ($expected -notmatch '^[a-f0-9]{64}$' -or (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $download $name)).Hash.ToLowerInvariant() -ne $expected) { throw 'Node download checksum mismatch.' }
        Expand-Archive -LiteralPath (Join-Path $download $name) -DestinationPath $download
        New-Item -ItemType Directory -Path $runtime -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path $download "node-v$version-win-$arch/node.exe") -Destination $binary
        return $binary
    } finally {
        $resolved = [IO.Path]::GetFullPath($download)
        if ($resolved.StartsWith([IO.Path]::GetTempPath()) -and [IO.Path]::GetFileName($resolved).StartsWith('pair-relay-download-')) { Remove-Item -LiteralPath $resolved -Recurse -Force }
    }
}

function Set-RelaySettings {
    $hostName = $Address
    if (-not $hostName) {
        $default = if ($script:settings) { $script:settings.Address } else { '' }
        $hostName = Select-RelayAddress -CurrentAddress $default
    }
    if (-not $hostName) { return $false }
    $ip = $null
    $isIp = [Net.IPAddress]::TryParse($hostName, [ref]$ip)
    if (-not $isIp -and $hostName -notmatch '^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$') { throw 'Enter only a DNS name or IP, without scheme or port.' }
    if ($Port -lt 1024 -or $Port -gt 65535) { throw 'Choose a port from 1024 to 65535.' }
    $san = if ($isIp) { "IPAddress=$hostName" } else { "DNS=$hostName" }
    $certificate = New-SelfSignedCertificate -Type Custom -Subject "CN=$hostName" -TextExtension @("2.5.29.17={text}$san", '2.5.29.19={text}CA=true', '2.5.29.37={text}1.3.6.1.5.5.7.3.1') -KeyUsage DigitalSignature,KeyEncipherment,CertSign -KeyExportPolicy Exportable -CertStoreLocation Cert:\CurrentUser\My -NotAfter (Get-Date).AddYears(1)
    try {
        $passwordBytes = New-Object byte[] 32
        $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
        try { $rng.GetBytes($passwordBytes) } finally { $rng.Dispose() }
        $rawPassword = [Convert]::ToBase64String($passwordBytes)
        $secret = ConvertTo-SecureString $rawPassword -AsPlainText -Force
        Export-PfxCertificate -Cert $certificate -FilePath (Join-Path $DataDirectory 'relay.pfx') -Password $secret | Out-Null
        $pem = "-----BEGIN CERTIFICATE-----`n" + [Convert]::ToBase64String($certificate.RawData, [Base64FormattingOptions]::InsertLineBreaks) + "`n-----END CERTIFICATE-----`n"
        [IO.File]::WriteAllText((Join-Path $DataDirectory 'relay-ca.crt'), $pem, [Text.Encoding]::ASCII)
        $script:settings = @{ Address = $hostName; Port = $Port; Password = ($secret | ConvertFrom-SecureString) }
        [IO.File]::WriteAllText($settingsFile, ($script:settings | ConvertTo-Json), [Text.Encoding]::UTF8)
    } finally { Remove-Item -LiteralPath "Cert:\CurrentUser\My\$($certificate.Thumbprint)" }
    return $true
}

function Get-RelayAddress {
    $name = $script:settings.Address
    if ($name.Contains(':')) { $name = "[$name]" }
    return "https://${name}:$($script:settings.Port)"
}

function Stop-Relay {
    if ($script:relay -and -not $script:relay.HasExited) {
        $script:relay.StandardInput.WriteLine('stop')
        if (-not $script:relay.WaitForExit(8000)) { $script:relay.Kill(); $script:relay.WaitForExit() }
    }
    if ($script:relay) { $script:relay.Dispose(); $script:relay = $null }
}

function Start-Relay {
    if ($script:relay -and -not $script:relay.HasExited) { return }
    if (-not $script:settings -and -not (Set-RelaySettings)) { return }
    if (-not $script:node) { $script:node = Get-NodeRuntime }
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = $script:node
    $start.Arguments = '"' + (Join-Path $PSScriptRoot 'relay.js') + '"'
    $start.UseShellExecute = $false; $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true; $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
    $start.EnvironmentVariables['PAIR_VPS_BIND'] = if ($script:settings.Address.Contains(':')) { '::' } else { '0.0.0.0' }
    $start.EnvironmentVariables['PAIR_VPS_PORT'] = [string]$script:settings.Port
    $start.EnvironmentVariables['PAIR_RELAY_TLS_PFX'] = Join-Path $DataDirectory 'relay.pfx'
    $credential = New-Object Net.NetworkCredential('', (ConvertTo-SecureString $script:settings.Password))
    $start.EnvironmentVariables['PAIR_RELAY_TLS_PASSWORD'] = $credential.Password
    $start.EnvironmentVariables['PAIR_RELAY_CONTROL_STDIN'] = '1'
    $script:relay = [Diagnostics.Process]::Start($start)
}

try {
    if (Test-Path -LiteralPath $settingsFile) { $script:settings = Get-Content -Raw -LiteralPath $settingsFile | ConvertFrom-Json }
    if ($SmokeTest) {
        if (-not $Address) { $Address = '127.0.0.1' }
        if (-not (Set-RelaySettings)) { throw 'Setup cancelled.' }
        Start-Relay
        Start-Sleep -Milliseconds 800
        $env:NODE_EXTRA_CA_CERTS = Join-Path $DataDirectory 'relay-ca.crt'
        & $script:node (Join-Path $PSScriptRoot 'check.js') (Get-RelayAddress)
        if ($LASTEXITCODE -ne 0) { throw 'Encrypted relay check failed.' }
        Stop-Relay
        [Console]::WriteLine('PASS: tray launcher TLS, encrypted exchange, reconnect and stop')
        exit 0
    }
    $tray = New-Object Windows.Forms.NotifyIcon
    $tray.Icon = [Drawing.SystemIcons]::Application
    $tray.Text = 'Pair Notebook relay - stopped'
    $menu = New-Object Windows.Forms.ContextMenuStrip
    $toggle = $menu.Items.Add('Start server')
    $copy = $menu.Items.Add('Copy HTTPS address')
    $certificateMenu = $menu.Items.Add('Show trust certificate')
    $configure = $menu.Items.Add('Change address')
    $exit = $menu.Items.Add('Exit')
    $tray.ContextMenuStrip = $menu; $tray.Visible = $true
    $update = { $running = $script:relay -and -not $script:relay.HasExited; $toggle.Text = if ($running) { 'Stop server' } else { 'Start server' }; $tray.Text = if ($running) { 'Pair Notebook relay - running' } else { 'Pair Notebook relay - stopped' } }
    $switch = { try { if ($script:relay -and -not $script:relay.HasExited) { Stop-Relay } else { Start-Relay }; & $update } catch { [Windows.Forms.MessageBox]::Show($_.Exception.Message, 'Pair Notebook relay') | Out-Null } }
    $toggle.Add_Click($switch)
    $tray.Add_MouseClick({ param($sender, $event) if ($event.Button -eq [Windows.Forms.MouseButtons]::Left) { & $switch } })
    $copy.Add_Click({ if ($script:settings) { [Windows.Forms.Clipboard]::SetText((Get-RelayAddress)) } })
    $certificateMenu.Add_Click({ if ($script:settings) { Start-Process explorer.exe -ArgumentList ('/select,"' + (Join-Path $DataDirectory 'relay-ca.crt') + '"') } })
    $configure.Add_Click({ Stop-Relay; $Address = ''; if (Set-RelaySettings) { Start-Relay }; & $update })
    $exit.Add_Click({ [Windows.Forms.Application]::Exit() })
    $timer = New-Object Windows.Forms.Timer
    $timer.Interval = 1000; $timer.Add_Tick($update); $timer.Start()
    Start-Relay; & $update
    $tray.ShowBalloonTip(7000, 'Pair Notebook relay', 'Left-click the tray icon to stop/start. Trust server\relay-ca.crt on each computer, then use Copy HTTPS address.', [Windows.Forms.ToolTipIcon]::Info)
    [Windows.Forms.Application]::Run()
} catch {
    if ($SmokeTest) { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
    [Windows.Forms.MessageBox]::Show($_.Exception.Message, 'Pair Notebook relay') | Out-Null
} finally {
    Stop-Relay
    if ($timer) { $timer.Dispose() }
    if ($tray) { $tray.Visible = $false; $tray.Dispose() }
}
