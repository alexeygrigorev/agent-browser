# Creates "Teach - Start recording" and "Teach - Stop recording" on the Desktop.
# User scope only: no administrator rights needed.
$repo = Split-Path -Parent $PSScriptRoot
$desktop = [Environment]::GetFolderPath('Desktop')
$shell = New-Object -ComObject WScript.Shell
foreach ($item in @(@{ Name = 'Teach - Start recording'; File = 'teach-start.cmd'; Icon = 'imageres.dll,-5340' },
                    @{ Name = 'Teach - Stop recording'; File = 'teach-stop.cmd'; Icon = 'imageres.dll,-5337' })) {
  $link = $shell.CreateShortcut((Join-Path $desktop "$($item.Name).lnk"))
  $link.TargetPath = Join-Path $PSScriptRoot $item.File
  $link.WorkingDirectory = $repo
  $link.IconLocation = "$env:SystemRoot\System32\$($item.Icon)"
  $link.Save()
  Write-Output "Created $(Join-Path $desktop "$($item.Name).lnk")"
}
