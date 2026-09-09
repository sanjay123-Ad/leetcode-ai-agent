@echo off
REM =====================================================
REM  AI LeetCode Agent - Windows Task Scheduler Setup
REM  Run this script ONCE as Administrator.
REM  Handles missed runs (if laptop was off at 8 AM).
REM =====================================================

echo Setting up AI LeetCode Agent scheduler...

REM Use PowerShell to create a task with "run if missed" enabled
powershell -Command ^
  "$action = New-ScheduledTaskAction -Execute 'C:\Users\sanja\Downloads\Leetcode AI\run-daily-agent.bat';" ^
  "$trigger = New-ScheduledTaskTrigger -Daily -At '08:00AM';" ^
  "$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RunOnlyIfNetworkAvailable -WakeToRun:$false;" ^
  "$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -RunLevel Highest;" ^
  "Register-ScheduledTask -TaskName 'AI LeetCode Daily Agent' -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force;"

IF %ERRORLEVEL% EQU 0 (
    echo.
    echo =====================================================
    echo  SUCCESS! Task registered with SMART settings:
    echo.
    echo  * Runs every day at 8:00 AM
    echo  * If laptop was OFF at 8 AM, it will run
    echo    automatically as soon as you turn it on!
    echo  * Requires internet connection to run
    echo =====================================================
    echo.
    echo  To run it NOW manually: 
    echo  schtasks /Run /TN "AI LeetCode Daily Agent"
    echo =====================================================
) ELSE (
    echo.
    echo  ERROR: Please right-click and Run as Administrator.
)

pause
