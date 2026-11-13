# Checks a signed Windows installer the way a person meets it, on a clean Windows runner: its signature, a silent
# per-user install, the installed app's signatures, a launch that stays up, and a silent uninstall that leaves nothing.
# Each step is logged with its result; any failure fails the run. Used by .github/workflows/release-win32.yml.
#
#   pwsh scripts/win32/verify-install.ps1 -Installer <setup.exe> -Seconds 30 -Publisher '19pine corp.'
param(
	[Parameter(Mandatory)] [string] $Installer,
	[int] $Seconds = 30,
	[Parameter(Mandatory)] [string] $Publisher,
	[string] $Name = 'Pine Drama Studio'
)
$ErrorActionPreference = 'Stop'
$results = [System.Collections.Generic.List[object]]::new()
function Step([string] $Step, [bool] $Ok, [string] $Detail) {
	$results.Add([pscustomobject]@{ Step = $Step; Ok = $Ok; Detail = $Detail })
	Write-Host ("[{0}] {1}: {2}" -f ($(if ($Ok) { 'PASS' } else { 'FAIL' }), $Step, $Detail))
}

# A file's Authenticode signature: valid, timestamped, and chaining to SSL.com (the CA behind eSigner).
function Signature([string] $Path) {
	$sig = Get-AuthenticodeSignature -FilePath $Path
	$chain = [System.Security.Cryptography.X509Certificates.X509Chain]::new()
	$null = $chain.Build($sig.SignerCertificate)
	$root = ($chain.ChainElements | Select-Object -Last 1).Certificate.Subject
	[pscustomobject]@{
		Ok = $sig.Status -eq 'Valid' -and $null -ne $sig.TimeStamperCertificate -and ($chain.ChainElements.Certificate.Subject -match 'SSL\.com')
		Detail = "status $($sig.Status); signer $($sig.SignerCertificate.Subject); timestamp by $($sig.TimeStamperCertificate.Subject); root $root"
	}
}

# 1. The installer's signature, twice: signtool's Authenticode policy and PowerShell's.
$verify = & signtool verify /pa /v $Installer 2>&1 | Out-String
Step 'signtool verify /pa /v (installer)' ($LASTEXITCODE -eq 0 -and $verify -match 'The signature is timestamped') (($verify -split "`n" | Select-String 'Issued to:|timestamped|Successfully verified|Number of') -join ' | ')
$s = Signature $Installer
Step 'Get-AuthenticodeSignature (installer)' $s.Ok $s.Detail

# 2. A silent per-user install, without launching the app afterwards (code.iss task runcode), with a desktop shortcut so
# that its removal is checked too. Inno Setup's command line: /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /MERGETASKS /LOG.
$log = Join-Path $env:RUNNER_TEMP 'install.log'
$p = Start-Process -FilePath $Installer -ArgumentList '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/MERGETASKS="desktopicon,!runcode"', "/LOG=`"$log`"" -Wait -PassThru
$dir = Join-Path $env:LOCALAPPDATA "Programs\$Name"
$exe = Join-Path $dir "$Name.exe"
Step 'silent install' ($p.ExitCode -eq 0 -and (Test-Path $exe)) "exit $($p.ExitCode); $exe $(if (Test-Path $exe) { 'present' } else { 'missing' })"
$uninstallKey = Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' | Where-Object { (Get-ItemProperty $_.PSPath).DisplayName -like "$Name*" } | Select-Object -First 1
$entry = if ($uninstallKey) { Get-ItemProperty $uninstallKey.PSPath }
Step 'Apps & Features entry' ($null -ne $entry -and $entry.Publisher -eq $Publisher) "$($uninstallKey.PSChildName): $($entry.DisplayName) $($entry.DisplayVersion), publisher '$($entry.Publisher)'"
$shortcuts = @(
	(Join-Path ([Environment]::GetFolderPath('Programs')) "$Name\$Name.lnk"),
	(Join-Path ([Environment]::GetFolderPath('Desktop')) "$Name.lnk")
)
Step 'shortcuts created' (@($shortcuts | Where-Object { Test-Path $_ }).Count -eq $shortcuts.Count) ($shortcuts -join '; ')

# 3. Every installed file of the kinds Code-OSS signs, and the uninstaller, is signed and timestamped.
$signed = Get-ChildItem $dir -Recurse -File | Where-Object { $_.Extension -match '^\.(exe|dll|node|ps1|psm1|psd1|ps1xml)$' }
$bad = @($signed | Where-Object { -not (Signature $_.FullName).Ok })
Step 'installed files signed and timestamped' ($signed.Count -gt 0 -and $bad.Count -eq 0) "$($signed.Count) files; not valid: $(($bad | ForEach-Object { $_.FullName.Substring($dir.Length + 1) }) -join ', ')"

# 4. Launch: the process starts and is still running after $Seconds seconds.
$app = Start-Process -FilePath $exe -PassThru
Start-Sleep -Seconds $Seconds
$app.Refresh()
$running = @(Get-Process -Name $Name -ErrorAction SilentlyContinue)
Step "launch, still running after $Seconds s" (-not $app.HasExited -and $running.Count -gt 0) "pid $($app.Id); $($running.Count) '$Name' processes; exited: $($app.HasExited)"
Get-Process -Name $Name -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 5

# 5. A silent uninstall. The uninstaller hands over to a copy of itself in the temporary folder and returns, so the
# check waits for the files to go, with a time limit.
$uninstaller = Join-Path $dir 'unins000.exe'
$u = Start-Process -FilePath $uninstaller -ArgumentList '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART' -Wait -PassThru
$deadline = (Get-Date).AddSeconds(180)
while ((Test-Path $exe) -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 3 }
$left = if (Test-Path $dir) { @(Get-ChildItem $dir -Recurse -File).Count } else { 0 }
Step 'silent uninstall removes the files' ($u.ExitCode -eq 0 -and $left -eq 0) "exit $($u.ExitCode); files left in ${dir}: $left"
Step 'shortcuts removed' (@($shortcuts | Where-Object { Test-Path $_ }).Count -eq 0) "left: $(($shortcuts | Where-Object { Test-Path $_ }) -join '; ')"
Step 'Apps & Features entry removed' (-not ($uninstallKey -and (Test-Path $uninstallKey.PSPath))) "$($uninstallKey.PSChildName)"

$table = "| Step | Result | Detail |`n|---|---|---|`n" + (($results | ForEach-Object { "| $($_.Step) | $(if ($_.Ok) { 'pass' } else { '**fail**' }) | $($_.Detail -replace '\|', '/') |" }) -join "`n")
if ($env:GITHUB_STEP_SUMMARY) { "## Windows install test`n`n$table" | Out-File -Append -Encoding utf8 $env:GITHUB_STEP_SUMMARY }
$table | Out-File -Encoding utf8 (Join-Path $env:RUNNER_TEMP 'install-test.md')
if (@($results | Where-Object { -not $_.Ok }).Count) { exit 1 }
