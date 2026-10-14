# A Windows launcher for the Linux agent INSIDE WSL2. Python/environment paths are Linux paths.
# Installation runs only when explicitly selected; existing distros and services are preserved.
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$Distro,
  [ValidateSet('Install','Check','Run')][string]$Action='Check',
  [string]$LinuxRoot='/opt/pair-notebook',
  [string]$Python='/opt/pair-notebook/venv/bin/python',
  [string[]]$AgentArguments=@()
)
$ErrorActionPreference='Stop'
if ($LinuxRoot -notmatch '^/[A-Za-z0-9_/-]+$' -or $Python -notmatch '^/[A-Za-z0-9_./-]+$') { throw 'Use explicit absolute Linux installation/environment paths.' }
$wslInfo = & wsl.exe --list --verbose
if ($LASTEXITCODE -ne 0) { throw 'Install WSL2 and a dedicated Ubuntu distribution first.' }
# Require actual WSL version 2, rather than treating a Linux-named process as isolation.
$plain = ($wslInfo -join "`n") -replace "`0",''
if ($plain -notmatch ('(?m)^.*\b' + [regex]::Escape($Distro) + '\s+\S+\s+2\s*$')) { throw 'The selected distribution must be running WSL2. Check wsl --list --verbose.' }
if ($Action -eq 'Install') {
  & wsl.exe --distribution $Distro --user root --exec sh -c 'set -eu; apt-get update; apt-get install -y python3-venv bubblewrap; install -d -m 0755 "$1/scripts" "$1/media"; python3 -m venv "$1/venv"; "$1/venv/bin/python" -m pip install jupyter_client==8.10.0 ipykernel==7.4.0' sh $LinuxRoot
  if ($LASTEXITCODE -ne 0) { throw 'WSL2 prerequisite installation failed.' }
  $files = @(@('scripts/pair-notebook-session-agent.py','scripts/pair-notebook-session-agent.py'), @('media/jupyter_kernel_bridge.py','media/jupyter_kernel_bridge.py'))
  foreach ($item in $files) {
    $source = Join-Path (Split-Path $PSScriptRoot -Parent) $item[0]
    $bytes = [Convert]::ToBase64String([IO.File]::ReadAllBytes($source))
    $bytes | & wsl.exe --distribution $Distro --user root --exec python3 -c 'import base64,pathlib,sys;p=pathlib.Path(sys.argv[1]);p.write_bytes(base64.b64decode(sys.stdin.read()));p.chmod(0o644)' "$LinuxRoot/$($item[1])"
    if ($LASTEXITCODE -ne 0) { throw 'WSL2 runtime source installation failed.' }
  }
}
$baseArguments = @('--distribution',$Distro,'--exec',$Python,"$LinuxRoot/scripts/pair-notebook-session-agent.py",'--python',$Python,'--bridge',"$LinuxRoot/media/jupyter_kernel_bridge.py")
if ($Action -ne 'Run') { & wsl.exe @baseArguments --check-isolation }
else { & wsl.exe @baseArguments @AgentArguments }
if ($LASTEXITCODE -ne 0) { throw 'The WSL2 agent failed closed. Inspect runtime readiness; do not use native Windows subprocess execution.' }
