# Sahibinden otomatik zamanlayici — Windows Gorev Zamanlayici
# Bilgisayar acikken her 30 dakikada bir gercek Chrome ile ceker.

$Scripts = $PSScriptRoot
$NodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $NodeCmd) {
  throw "Node.js bulunamadi. https://nodejs.org kurulu olmali."
}
$Node = $NodeCmd.Source

$Bridge = Join-Path $Scripts "sahibinden-bridge.mjs"
$Log = Join-Path $Scripts "sahibinden-bridge.log"
$TaskName = "SahibindenIlanOtomatik"
$TaskNameBoot = "SahibindenIlanOtomatikBoot"
$WorkDir = $Scripts

$Runner = Join-Path $Scripts "run-sahibinden-bridge.cmd"
$RunnerContent = @"
@echo off
cd /d "$WorkDir"
"$Node" "$Bridge" >> "$Log" 2>&1
"@
Set-Content -Path $Runner -Value $RunnerContent -Encoding ASCII

cmd /c "schtasks /Delete /TN $TaskName /F >nul 2>&1"
cmd /c "schtasks /Delete /TN $TaskNameBoot /F >nul 2>&1"

$out1 = cmd /c "schtasks /Create /TN `"$TaskName`" /TR `"\`"$Runner\`"`" /SC MINUTE /MO 30 /RL LIMITED /F"
Write-Host $out1
if ($LASTEXITCODE -ne 0) { throw "Zamanlayici olusturulamadi: $out1" }

$out2 = cmd /c "schtasks /Create /TN `"$TaskNameBoot`" /TR `"\`"$Runner\`"`" /SC ONLOGON /RL LIMITED /F"
Write-Host $out2
if ($LASTEXITCODE -ne 0) { throw "Boot zamanlayici olusturulamadi: $out2" }

Write-Host "OK: '$TaskName' her 30 dk + oturum acilisinda calisacak."
Write-Host "Log: $Log"
Write-Host "Simdi ilk tarama baslatiliyor..."

Start-Process -FilePath $Node -ArgumentList "`"$Bridge`"" -WorkingDirectory $WorkDir -WindowStyle Hidden
Write-Host "Ilk tarama arka planda basladi."
