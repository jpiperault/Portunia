; Portunia s'appelait Termoria. L'installation retire l'ancienne application (programme,
; raccourcis, entrée « Applications installées ») sans toucher à ses données : Portunia les
; copie au premier lancement. Puis elle recrée les raccourcis, que Tauri ne crée pas lors
; d'une mise à jour automatique.

Var OldTermoriaDir
Var OldTermoriaDesktop

!macro NSIS_HOOK_PREINSTALL
  StrCpy $OldTermoriaDir ""
  StrCpy $OldTermoriaDesktop 0
  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Termoria" "InstallLocation"
  ${WordReplace} $0 '"' "" "+" $0
  ${If} $0 != ""
  ${AndIf} ${FileExists} "$0\uninstall.exe"
    StrCpy $OldTermoriaDir $0
    ${If} ${FileExists} "$DESKTOP\Termoria.lnk"
      StrCpy $OldTermoriaDesktop 1
    ${EndIf}
    !insertmacro CheckIfAppIsRunning "$OldTermoriaDir\termoria.exe" "Termoria"
    ; « _?= » : désinstallation sur place, attendue jusqu'au bout. Sans interface,
    ; la case « supprimer les données » reste décochée : les données sont gardées.
    ExecWait '"$OldTermoriaDir\uninstall.exe" /S _?=$OldTermoriaDir'
    Delete "$OldTermoriaDir\uninstall.exe"
    RMDir "$OldTermoriaDir"
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ${If} $OldTermoriaDir != ""
  ${AndIf} $UpdateMode = 1
    CreateShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\${PRODUCTNAME}.lnk"
    ${If} $OldTermoriaDesktop = 1
      CreateShortcut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
      !insertmacro SetLnkAppUserModelId "$DESKTOP\${PRODUCTNAME}.lnk"
    ${EndIf}
  ${EndIf}
!macroend
