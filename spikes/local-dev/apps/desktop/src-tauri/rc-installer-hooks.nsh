; SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
; This RC channel has a fixed installation directory and never removes app data.
; Keep the checks before Tauri's main-executable process check and file mutations.
!macro RC_CHECK_DIRECTORY
  GetFullPathName $R8 "$INSTDIR"
  GetFullPathName $R9 "$LOCALAPPDATA\远舟 RC 20260909"
  ${If} $R8 != $R9
    SetErrorLevel 2
    Abort "RC installation is restricted to $LOCALAPPDATA\远舟 RC 20260909."
  ${EndIf}
  System::Call 'kernel32::GetFileAttributesW(w rR8) i .rR9'
  ${If} $R9 != -1
    IntOp $R9 $R9 & 0x400
    ${If} $R9 != 0
      SetErrorLevel 2
      Abort "RC installation directory must not be a junction or symbolic link."
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro RC_CHECK_DIRECTORY
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro RC_CHECK_DIRECTORY
  ; Credentials require explicit platform logout/revoke and native QA cleanup.
  ; Preserving configuration also makes binary rollback possible.
  StrCpy $DeleteAppDataCheckboxState 0
  DetailPrint "RC uninstall preserves application configuration and credential entries."
!macroend
