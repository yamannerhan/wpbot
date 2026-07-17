# Her 30 dk Sahibinden ilan cek (ev IP + kayitli Google oturumu)

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not (Test-Path (Join-Path $Root "Sahibinden-Otomatik.cmd"))) {
  $Root = Split-Path -Parent $PSScriptRoot
}
$Runner = Join-Path $Root "Sahibinden-Otomatik.cmd"
$TaskName = "SahibindenIlanOtomatik"
$TaskBoot = "SahibindenIlanOtomatikBoot"

cmd /c "schtasks /Delete /TN $TaskName /F >nul 2>&1"
cmd /c "schtasks /Delete /TN $TaskBoot /F >nul 2>&1"

cmd /c "schtasks /Create /TN `"$TaskName`" /TR `"\`"$Runner\`"`" /SC MINUTE /MO 30 /RL LIMITED /F"
cmd /c "schtasks /Create /TN `"$TaskBoot`" /TR `"\`"$Runner\`"`" /SC ONLOGON /RL LIMITED /F"

Write-Host "OK: Her 30 dk + oturum acilisinda Sahibinden cekilecek."
Write-Host "Once bir kez Sahibinden-Giris.cmd ile Google girisi yap."
