' start-server.vbs - sobe so o servidor (start.ps1 -ServerOnly), oculto, sem abrir janela.
' Atalho na pasta Inicializar do Windows (shell:startup) aponta pra ca: o orquestrador
' ja esta de pe no login e o celular acha pelo Tailscale.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
ps1 = fso.GetParentFolderName(WScript.ScriptFullName) & "\start.ps1"
sh.Run "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & ps1 & """ -ServerOnly", 0, False
