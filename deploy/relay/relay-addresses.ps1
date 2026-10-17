function Get-RelayAddressCandidates {
    param([object[]]$Configurations)
    $items = foreach ($config in $Configurations) {
        if ($config.NetAdapter.Status -ne 'Up') { continue }
        $physical = $config.NetAdapter.HardwareInterface -eq $true -and $config.NetAdapter.Virtual -ne $true
        foreach ($ip in @($config.IPv4Address) + @($config.IPv6Address)) {
            $value = [string]$ip.IPAddress
            if (-not $value -or $value -match '^(127\.|169\.254\.|::1$|fe80:|0\.)') { continue }
            [pscustomobject]@{ Address = $value; Adapter = $config.InterfaceAlias; Physical = $physical; Rank = $(if ($physical -and $value -notmatch ':') { 0 } elseif ($physical) { 1 } else { 2 }) }
        }
    }
    @($items | Sort-Object Rank, Adapter, Address)
}

function Select-RelayAddress {
    param([string]$CurrentAddress)
    $candidates = @(Get-RelayAddressCandidates -Configurations @(Get-NetIPConfiguration -All))
    $dialog = New-Object Windows.Forms.Form
    $dialog.Text = 'Pair Notebook server address'
    $dialog.Size = New-Object Drawing.Size(620, 360)
    $dialog.StartPosition = 'CenterScreen'
    $dialog.FormBorderStyle = 'FixedDialog'
    $dialog.MaximizeBox = $false; $dialog.MinimizeBox = $false
    $help = New-Object Windows.Forms.Label
    $help.Text = "Choose the address other computers can reach. Physical Wi-Fi/Ethernet is recommended for the same LAN. VPN and virtual adapters are listed below it."
    $help.Location = New-Object Drawing.Point(16, 15); $help.Size = New-Object Drawing.Size(570, 42)
    $list = New-Object Windows.Forms.ListBox
    $list.Location = New-Object Drawing.Point(16, 64); $list.Size = New-Object Drawing.Size(570, 120)
    foreach ($item in $candidates) {
        $kind = if ($item.Physical) { 'physical' } else { 'VPN / virtual' }
        $prefix = if ($item -eq $candidates[0] -and $item.Physical) { 'Recommended: ' } else { '' }
        [void]$list.Items.Add("$prefix$($item.Address) - $($item.Adapter) ($kind)")
    }
    $manual = New-Object Windows.Forms.TextBox
    $manual.Location = New-Object Drawing.Point(16, 204); $manual.Width = 570
    $manual.Text = if ($CurrentAddress) { $CurrentAddress } elseif ($candidates.Count) { $candidates[0].Address } else { '' }
    $list.Add_SelectedIndexChanged({ if ($list.SelectedIndex -ge 0) { $manual.Text = $candidates[$list.SelectedIndex].Address } })
    $hint = New-Object Windows.Forms.Label
    $hint.Text = 'Or enter your DNS name / IP above. A LAN IP is not a public Internet address. Internet access needs a reachable public port or tunnel.'
    $hint.Location = New-Object Drawing.Point(16, 236); $hint.Size = New-Object Drawing.Size(570, 36)
    $ok = New-Object Windows.Forms.Button
    $ok.Text = 'Use address'; $ok.DialogResult = 'OK'; $ok.Location = New-Object Drawing.Point(360, 282); $ok.Width = 110
    $cancel = New-Object Windows.Forms.Button
    $cancel.Text = 'Cancel'; $cancel.DialogResult = 'Cancel'; $cancel.Location = New-Object Drawing.Point(480, 282)
    $dialog.Controls.AddRange(@($help, $list, $manual, $hint, $ok, $cancel))
    $dialog.AcceptButton = $ok; $dialog.CancelButton = $cancel
    try { if ($dialog.ShowDialog() -eq 'OK') { return $manual.Text.Trim() }; return '' }
    finally { $dialog.Dispose() }
}
