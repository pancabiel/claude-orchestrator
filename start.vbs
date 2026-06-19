' start.vbs — runs start.ps1 fully hidden (no console flash). Use this for the shortcut.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
ps1 = fso.GetParentFolderName(WScript.ScriptFullName) & "\start.ps1"
sh.Run "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & ps1 & """", 0, False
