; SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
; Generated definitions supply product identity, paths and pinned runtime payload.
Unicode true
ManifestDPIAware true
RequestExecutionLevel user
SetCompressor /SOLID lzma
!include MUI2.nsh
!include FileFunc.nsh
!include LogicLib.nsh
!include x64.nsh
Name "${PRODUCTNAME} WebView2"
OutFile "${YZ_COMPONENT_OUTFILE}"
VIProductVersion "${YZ_RUNTIME_VERSION}"
VIAddVersionKey "ProductName" "${PRODUCTNAME} WebView2"
VIAddVersionKey "FileDescription" "${PRODUCTNAME} WebView2 component"
VIAddVersionKey "FileVersion" "${YZ_RUNTIME_VERSION}"
VIAddVersionKey "LegalCopyright" "Microsoft WebView2 Runtime; Yuan Zhou installer"
!define YZ_WEBVIEW_PAYLOAD 1
Var PassiveMode
Var UpdateMode
!include "${YZ_COMPONENT_INCLUDE}"

Page custom ComponentPage ComponentPageLeave
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"
!insertmacro YZ_LANGUAGE_STRINGS
LangString ComponentMissing 2052 "请先安装远舟客户端，再运行对应的 WebView2 组件包。未找到有效的客户端安装目录。"
LangString ComponentMissing 1033 "Install the matching Yuan Zhou client first. No valid client installation was found."
LangString ComponentBusy 2052 "请关闭远舟后重试，并检查安装目录是否可写。组件操作不会修改配对、设置或历史。"
LangString ComponentBusy 1033 "Close Yuan Zhou and check installation-folder access before retrying. Pairing, settings and history are retained."
LangString ComponentHelp 2052 "勾选：安装、更新或修复独立 WebView2。$\r$\n取消勾选：移除组件，恢复系统 WebView2。$\r$\n$\r$\n组件安装后，日常更新只需客户端小包，无需重复安装本组件。请先关闭远舟。"
LangString ComponentHelp 1033 "Checked: install, update or repair private WebView2.$\r$\nUnchecked: remove it and use system WebView2.$\r$\n$\r$\nClient updates retain this component. Close Yuan Zhou before continuing."

Function CheckComponentTarget
  ; Never accept /D overrides: operate on the registered current-user product only.
  ReadRegStr $INSTDIR HKCU "${MANUPRODUCTKEY}" ""
  ${If} $INSTDIR == ""
    Goto missing
  ${EndIf}
  !ifdef YZ_RC_DIRECTORY
    GetFullPathName $0 "$INSTDIR"
    GetFullPathName $1 "$LOCALAPPDATA\${PRODUCTNAME}"
    ${If} $0 != $1
      Goto missing
    ${EndIf}
  !endif
  !insertmacro YZ_CHECK_RUNTIME_PATHS ""
  System::Call 'kernel32::GetFileAttributesW(w "$INSTDIR\${MAINBINARYNAME}.exe") i .r0'
  ${If} $0 == -1
    Goto missing
  ${EndIf}
  IntOp $0 $0 & 0x410
  ${If} $0 != 0
    Goto missing
  ${EndIf}
  ; Opening an executable for write fails while its image is running. No bytes
  ; are changed. Also reject inaccessible/locked targets before staging files.
  System::Call 'kernel32::CreateFileW(w "$INSTDIR\${MAINBINARYNAME}.exe", i 0x40000000, i 7, p 0, i 3, i 0, p 0) p .r0'
  ${If} $0 == -1
    SetErrorLevel 2
    MessageBox MB_OK|MB_ICONSTOP "$(ComponentBusy)" /SD IDOK
    Abort
  ${EndIf}
  System::Call 'kernel32::CloseHandle(p r0)'
  Return
  missing:
    SetErrorLevel 2
    MessageBox MB_OK|MB_ICONSTOP "$(ComponentMissing)" /SD IDOK
    Abort
FunctionEnd

Function .onInit
  ${IfNot} ${RunningX64}
    SetErrorLevel 2
    Abort "Windows x64 is required."
  ${EndIf}
  SetShellVarContext current
  SetRegView 64
  StrCpy $LANGUAGE 2052
  Call CheckComponentTarget
  ; Running this dedicated tool explicitly requests component installation.
  StrCpy $YzWebViewSelected 1
  ${GetOptions} $CMDLINE "/WEBVIEW2=" $0
  ${IfNot} ${Errors}
    ${If} $0 == "0"
      StrCpy $YzWebViewSelected 0
    ${ElseIf} $0 != "1"
      SetErrorLevel 2
      Abort "Invalid /WEBVIEW2 option: use /WEBVIEW2=1 or /WEBVIEW2=0."
    ${EndIf}
  ${EndIf}
  Call YzUpdateInstallSize
FunctionEnd

Function ComponentPage
  !insertmacro MUI_HEADER_TEXT "$(YzWebViewTitle)" "${PRODUCTNAME} WebView2 ${YZ_RUNTIME_VERSION}"
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    SetErrorLevel 2
    Abort
  ${EndIf}
  ${NSD_CreateCheckbox} 0 8u 100% 20u "$(YzWebViewChoice)"
  Pop $YzWebViewCheckbox
  ${NSD_SetState} $YzWebViewCheckbox $YzWebViewSelected
  ${NSD_CreateLabel} 0 36u 100% 100u "$(ComponentHelp)"
  Pop $0
  nsDialogs::Show
FunctionEnd

Function ComponentPageLeave
  ${NSD_GetState} $YzWebViewCheckbox $YzWebViewSelected
  Call YzUpdateInstallSize
FunctionEnd

Section "WebView2" YZ_MAIN_SECTION
  Call CheckComponentTarget
  !insertmacro YZ_INSTALL_WEBVIEW
SectionEnd
!insertmacro YZ_SIZE_FUNCTIONS
