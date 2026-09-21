; SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
; Synthetic install/uninstall host. Never points at a real product or profile.
Unicode true
RequestExecutionLevel user
!include MUI2.nsh
!include FileFunc.nsh
!include LogicLib.nsh
Name "Yuan Zhou runtime test fixture"
OutFile "${YZ_TEST_OUTFILE}"
InstallDir "${YZ_TEST_INSTALLDIR}"
Var PassiveMode
Var UpdateMode
Var SeedMode
Var UpgradeMode
!include "${YZ_TEST_INCLUDE}"
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"
!insertmacro YZ_LANGUAGE_STRINGS

Function .onInit
  SetShellVarContext current
  SetRegView 64
  ${GetOptions} $CMDLINE "/SEED" $SeedMode
  ${IfNot} ${Errors}
    StrCpy $SeedMode 1
    Return
  ${EndIf}
  ${GetOptions} $CMDLINE "/UPDATE" $UpdateMode
  ${IfNot} ${Errors}
    StrCpy $UpdateMode 1
  ${EndIf}
  ${GetOptions} $CMDLINE "/UPGRADE" $UpgradeMode
  ${IfNot} ${Errors}
    StrCpy $UpgradeMode 1
  ${EndIf}
  Call YzEnsureSelection
  !if ${YZ_WEBVIEW_PAYLOAD} == 0
    Call YzValidateRetainedRuntime
  !endif
FunctionEnd

Function un.onInit
  SetShellVarContext current
  SetRegView 64
  ${GetOptions} $CMDLINE "/UPDATE" $UpdateMode
  ${IfNot} ${Errors}
    StrCpy $UpdateMode 1
  ${EndIf}
FunctionEnd

Section Install YZ_MAIN_SECTION
  SetOutPath $INSTDIR
  ${If} $SeedMode == 1
    WriteRegStr HKCU "${MANUPRODUCTKEY}" "" "$INSTDIR"
    FileOpen $0 "$INSTDIR\fixture-client.exe" w
    FileWrite $0 "original-client"
    FileClose $0
    FileOpen $0 "$INSTDIR\profile-sentinel.txt" w
    FileWrite $0 "pairing-and-history-fixture"
    FileClose $0
  ${Else}
    ${If} $UpgradeMode == 1
      ; Matches the invocation site in Tauri's interactive replacement path.
      StrCpy $R1 '$\"$INSTDIR\uninstall.exe$\" /S'
      !insertmacro YZ_PREVIOUS_UNINSTALL_ARGS
      StrCpy $R1 "$R1 _?=$INSTDIR"
      ExecWait '$R1' $0
      ${If} $0 != 0
        SetErrorLevel 2
        Abort
      ${EndIf}
    ${EndIf}
    !insertmacro YZ_INSTALL_WEBVIEW
    SetOutPath $INSTDIR
    FileOpen $0 "$INSTDIR\fixture-client.exe" w
    FileWrite $0 "updated-client"
    FileClose $0
  ${EndIf}
  WriteUninstaller "$INSTDIR\uninstall.exe"
SectionEnd

Section Uninstall
  ; This macro's /UPDATE behavior is unchanged from 0.2.4.
  !insertmacro YZ_UNINSTALL_WEBVIEW
  Delete "$INSTDIR\fixture-client.exe"
  Delete "$INSTDIR\uninstall.exe"
  ${If} $UpdateMode != 1
    DeleteRegKey HKCU "${MANUPRODUCTKEY}"
  ${EndIf}
SectionEnd
!insertmacro YZ_SIZE_FUNCTIONS
