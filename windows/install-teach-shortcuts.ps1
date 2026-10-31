# Creates "Teach - Start recording" (Ctrl+Alt+F9) and "Teach - Stop recording"
# (Ctrl+Alt+F10) on the Desktop. User scope only: no administrator rights needed.
$repo = Split-Path -Parent $PSScriptRoot
$desktop = [Environment]::GetFolderPath('Desktop')
$shell = New-Object -ComObject WScript.Shell
foreach ($item in @(@{ Name = 'Teach - Start recording'; File = 'teach-start.cmd'; Icon = 'imageres.dll,-5340'; Hotkey = 'CTRL+ALT+F9' },
                    @{ Name = 'Teach - Stop recording'; File = 'teach-stop.cmd'; Icon = 'imageres.dll,-5337'; Hotkey = 'CTRL+ALT+F10' })) {
  $link = $shell.CreateShortcut((Join-Path $desktop "$($item.Name).lnk"))
  $link.TargetPath = Join-Path $PSScriptRoot $item.File
  $link.WorkingDirectory = $repo
  $link.IconLocation = "$env:SystemRoot\System32\$($item.Icon)"
  $link.Hotkey = $item.Hotkey
  $link.Save()
  Write-Output "Created $(Join-Path $desktop "$($item.Name).lnk") ($($item.Hotkey))"
}
