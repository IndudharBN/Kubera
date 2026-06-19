# ============================================================================
#  Kubera — Register morning auto-start with Windows Task Scheduler
#  Run ONCE (no admin needed).
#      powershell -ExecutionPolicy Bypass -File .\REGISTER_MORNING_START.ps1
#
#  Creates task "Kubera-MorningStart" that runs ENSURE_RUNNING.bat:
#    - DAILY (Mon–Fri) at 04:15 local time.
#
#  Why 04:15 local: NSE opens 09:15 IST = 04:45 BST (UK summer). 04:15 is ~30 min
#  before the open and AFTER Kite's ~07:30 IST (~03:00 BST) token reset, so the
#  daemon's fresh TOTP login on boot grabs a full-day token.
#
#  ⚠ DST: 04:15 is LOCAL clock time. In UK winter (GMT) 04:15 = 09:45 IST = 30 min
#  AFTER the open — re-run this with 03:15 after the late-Oct clock change, or just
#  start the daemon manually those days.
#
#  WakeToRun is set true as belt-and-suspenders, but this machine is Modern-Standby
#  (no S3) so the real guarantee is your sleep=Never setting keeping it awake.
#  ENSURE_RUNNING.bat is idempotent — if the daemon is already up it exits in <1s.
# ============================================================================

$ErrorActionPreference = 'Stop'
$root     = Split-Path -Parent $MyInvocation.MyCommand.Path
$script   = Join-Path $root 'ENSURE_RUNNING.bat'
$taskName = 'Kubera-MorningStart'

if (-not (Test-Path $script)) { throw "ENSURE_RUNNING.bat not found at $script" }

$svc = New-Object -ComObject Schedule.Service
$svc.Connect()
$rootFolder = $svc.GetFolder('\')

$def = $svc.NewTask(0)
$def.RegistrationInfo.Description = 'Start Kubera daemon (5003) + UI (5004) every weekday at 04:15 local, ~30 min before NSE open (BST).'
$def.Settings.Enabled                    = $true
$def.Settings.StartWhenAvailable         = $true   # catch up if the trigger was missed
$def.Settings.WakeToRun                  = $true   # belt-and-suspenders (machine is sleep=Never anyway)
$def.Settings.DisallowStartIfOnBatteries = $false
$def.Settings.StopIfGoingOnBatteries     = $false
$def.Settings.ExecutionTimeLimit         = 'PT0S'  # no time limit
$def.Settings.MultipleInstances          = 2       # ignore new instance if already running

# Trigger: WEEKLY Mon–Fri at 04:15 (TASK_TRIGGER_WEEKLY = 3)
# DaysOfWeek bitmask: Mon2 Tue4 Wed8 Thu16 Fri32 = 62
$t                = $def.Triggers.Create(3)
$t.StartBoundary  = '2026-06-22T04:15:00'   # first eligible day (Mon); time-of-day is what repeats
$t.DaysOfWeek     = 62
$t.WeeksInterval  = 1
$t.Enabled        = $true

# Action: run the guarded idempotent starter
$action                  = $def.Actions.Create(0)  # TASK_ACTION_EXEC
$action.Path             = "$env:SystemRoot\System32\cmd.exe"
$action.Arguments        = "/c `"$script`""
$action.WorkingDirectory = $root

# Register: 6 = CREATE_OR_UPDATE, 3 = run only when user is logged on (ENSURE_RUNNING opens a cmd window + pm2)
$rootFolder.RegisterTaskDefinition($taskName, $def, 6, $null, $null, 3) | Out-Null

Write-Host ""
Write-Host "  Registered scheduled task '$taskName'." -ForegroundColor Green
Write-Host "  Trigger: Mon-Fri 04:15 local  ->  $script"
Write-Host ""
Write-Host "  Test now:   Start-ScheduledTask -TaskName '$taskName'"
Write-Host "  Inspect:    Get-ScheduledTask -TaskName '$taskName' | Get-ScheduledTaskInfo"
Write-Host "  Remove:     Unregister-ScheduledTask -TaskName '$taskName' -Confirm:`$false"
Write-Host ""
