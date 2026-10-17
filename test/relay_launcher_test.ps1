param([Parameter(Mandatory=$true)][string]$Archive)
$ErrorActionPreference = 'Stop'
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('pair-relay-test-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $fixture | Out-Null
try {
    Expand-Archive -LiteralPath $Archive -DestinationPath $fixture
    $listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $port = $listener.LocalEndpoint.Port
    $listener.Stop()
    $subjects = @()
    for ($round = 0; $round -lt 2; $round++) {
        & powershell.exe -NoProfile -File (Join-Path $fixture 'pair-notebook-ws-server.ps1') -SmokeTest -Address 127.0.0.1 -Port $port -DataDirectory (Join-Path $fixture 'state')
        if ($LASTEXITCODE -ne 0) { throw 'Packaged Windows relay failed its TLS/encrypted/reconnect/stop check.' }
        $certificate = New-Object Security.Cryptography.X509Certificates.X509Certificate2((Join-Path $fixture 'state/relay-ca.crt'))
        try { $subjects += $certificate.Subject } finally { $certificate.Dispose() }
    }
    if ($subjects[0] -eq $subjects[1]) { throw 'Regenerated local certificates must have distinct issuer names.' }
    Write-Output 'PASS: packaged relay readiness and two certificate generations; no TLS bypass.'
} finally {
    $resolved = [IO.Path]::GetFullPath($fixture)
    if ($resolved.StartsWith([IO.Path]::GetTempPath()) -and [IO.Path]::GetFileName($resolved).StartsWith('pair-relay-test-')) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
