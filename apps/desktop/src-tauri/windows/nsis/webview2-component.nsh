; SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
; Included after Tauri's product/install-mode definitions and before its pages.
!include nsDialogs.nsh
!ifndef YZ_WEBVIEW_PAYLOAD
  !define YZ_WEBVIEW_PAYLOAD 1
!endif

Var YzWebViewSelected
Var YzWebViewDirectory
Var YzWebViewCheckbox
Var YzWebViewBaseSize
Var YzWebViewSizeInitialized

; Expanded after Tauri loads its MUI languages. IDs are Chinese / English.
!macro YZ_LANGUAGE_STRINGS
LangString YzWebViewTitle 2052 "可选运行环境"
LangString YzWebViewTitle 1033 "Optional runtime"
LangString YzWebViewSubtitle 2052 "正常电脑无需安装；窗口无法打开或白屏时可补装。"
LangString YzWebViewSubtitle 1033 "Optional help for missing windows or blank screens."
LangString YzWebViewChoice 2052 "安装独立 WebView2 运行环境"
LangString YzWebViewChoice 1033 "Install a private WebView2 runtime"
LangString YzWebViewHelp 2052 "勾选后，远舟使用安装包自带的运行环境，无需联网，也不会替换系统 WebView2。$\r$\n$\r$\n首次安装默认不勾选；升级保留上次选择。取消已有勾选会移除独立组件，恢复使用系统 WebView2。$\r$\n$\r$\n已安装远舟后仍可重新运行安装器补装，保留配对、设置和历史。"
LangString YzWebViewHelp 1033 "Uses the runtime included in this installer, without a download or replacing system WebView2.$\r$\n$\r$\nOff by default on first install; upgrades retain your choice. Unchecking removes the private runtime and uses system WebView2.$\r$\n$\r$\nRun this installer again to add the component while keeping pairing, settings and history."
LangString YzWebViewFailure 2052 "独立 WebView2 组件安装失败。请关闭远舟，检查磁盘空间和安装目录权限后重新运行安装器。"
LangString YzWebViewFailure 1033 "Could not install the private WebView2 runtime. Close the app, check free disk space and installation folder permissions, then run the installer again."
LangString YzWebViewPathFailure 2052 "运行环境目录不安全或正在使用，无法继续。请选择本机普通目录，并关闭远舟后重试。"
LangString YzWebViewPathFailure 1033 "The runtime folder is unsafe or in use. Choose a regular local folder, close the app, then try again."
LangString YzWebViewRetain 2052 "此客户端安装包不包含独立 WebView2。已安装的组件会保留并继续使用，功能更新无需重复下载组件。$\r$\n$\r$\n如需补装、修复或移除组件，请单独运行远舟 WebView2 组件安装包。"
LangString YzWebViewRetain 1033 "This client installer does not include a private WebView2 runtime. An installed component is retained and reused.$\r$\n$\r$\nTo add, repair, or remove it, run the separate Yuan Zhou WebView2 component installer."
LangString YzWebViewRepair 2052 "独立 WebView2 组件不完整。请先运行远舟 WebView2 组件安装包进行修复，再更新客户端。"
LangString YzWebViewRepair 1033 "The private WebView2 component is incomplete. Repair it with the separate component installer before updating the client."
!macroend

!macro YZ_PREVIOUS_UNINSTALL_ARGS
  ${If} $UpdateMode = 1
  ${OrIf} $YzWebViewSelected = 1
    StrCpy $R1 "$R1 /UPDATE"
  ${EndIf}
!macroend

Function YzEnsureSelection
  ${If} $YzWebViewDirectory == $INSTDIR
    Return
  ${EndIf}
  StrCpy $YzWebViewDirectory $INSTDIR
  StrCpy $YzWebViewSelected 0
  ReadRegDWORD $0 SHCTX "${MANUPRODUCTKEY}" "IndependentWebView2"
  ${If} $0 == 1
    StrCpy $YzWebViewSelected 1
  ${EndIf}
  IfFileExists "$INSTDIR\WebView2Fixed\*.*" 0 +2
    StrCpy $YzWebViewSelected 1
  IfFileExists "$INSTDIR\webview2-component.enabled" 0 +2
    StrCpy $YzWebViewSelected 1
  ClearErrors
  ${GetOptions} $CMDLINE "/WEBVIEW2=" $0
  ${IfNot} ${Errors}
    !if ${YZ_WEBVIEW_PAYLOAD} == 0
      SetErrorLevel 2
      MessageBox MB_OK|MB_ICONSTOP "$(YzWebViewRetain)" /SD IDOK
      Abort
    !else
    ${If} $0 == "1"
      StrCpy $YzWebViewSelected 1
    ${ElseIf} $0 == "0"
      StrCpy $YzWebViewSelected 0
    ${Else}
      SetErrorLevel 2
      Abort "Invalid /WEBVIEW2 option: use /WEBVIEW2=1 or /WEBVIEW2=0."
    ${EndIf}
    !endif
  ${EndIf}
  ClearErrors
  Call YzUpdateInstallSize
FunctionEnd

Function YzWebViewPage
  Call YzEnsureSelection
  ${If} $PassiveMode == 1
  ${OrIf} $UpdateMode == 1
    Abort
  ${EndIf}
  !insertmacro MUI_HEADER_TEXT "$(YzWebViewTitle)" "$(YzWebViewSubtitle)"
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    SetErrorLevel 2
    Abort
  ${EndIf}
  !if ${YZ_WEBVIEW_PAYLOAD} == 0
    ${NSD_CreateLabel} 0 8u 100% 100u "$(YzWebViewRetain)"
    Pop $0
  !else
  ${NSD_CreateCheckbox} 0 8u 100% 20u "$(YzWebViewChoice)"
  Pop $YzWebViewCheckbox
  ${NSD_SetState} $YzWebViewCheckbox $YzWebViewSelected
  ${NSD_CreateLabel} 0 36u 100% 100u "$(YzWebViewHelp)"
  Pop $0
  !endif
  nsDialogs::Show
FunctionEnd

Function YzWebViewPageLeave
  !if ${YZ_WEBVIEW_PAYLOAD} == 1
  ${NSD_GetState} $YzWebViewCheckbox $YzWebViewSelected
  Call YzUpdateInstallSize
  !endif
FunctionEnd

; Expanded after the main Section ID is defined. Exclude optional payload from
; required disk space when unchecked (NSIS otherwise counts all File commands).
!macro YZ_SIZE_FUNCTIONS
Function YzUpdateInstallSize
  Push $0
  ${If} $YzWebViewSizeInitialized != 1
    SectionGetSize ${YZ_MAIN_SECTION} $YzWebViewBaseSize
    IntOp $YzWebViewBaseSize $YzWebViewBaseSize - ${YZ_WEBVIEW_KIB}
    StrCpy $YzWebViewSizeInitialized 1
  ${EndIf}
  StrCpy $0 $YzWebViewBaseSize
  ${If} $YzWebViewSelected == 1
    ; Staging temporarily needs room for the replacement alongside the old copy.
    IntOp $0 $0 + ${YZ_WEBVIEW_KIB}
  ${EndIf}
  SectionSetSize ${YZ_MAIN_SECTION} $0
  Pop $0
FunctionEnd
!macroend

; Scope all recursive removals to our three owned folders, never $INSTDIR itself.
; Reject roots, UNC and reparse points before any component mutation.
!macro YZ_CHECK_RUNTIME_PATHS PREFIX
  GetFullPathName $0 "$INSTDIR"
  ${GetRoot} "$0" $1
  ${If} $0 == $1
  ${OrIf} $0 == "$1\"
  ${OrIf} $0 == ""
    SetErrorLevel 2
    Abort "$(YzWebViewPathFailure)"
  ${EndIf}
  StrCpy $1 $0 2
  ${If} $1 == "\\"
    SetErrorLevel 2
    Abort "$(YzWebViewPathFailure)"
  ${EndIf}
  !insertmacro YZ_CHECK_DIRECTORY "$INSTDIR"
  !insertmacro YZ_CHECK_DIRECTORY "$INSTDIR\WebView2Fixed"
  !insertmacro YZ_CHECK_DIRECTORY "$INSTDIR\WebView2Fixed.stage"
  !insertmacro YZ_CHECK_DIRECTORY "$INSTDIR\WebView2Fixed.previous"
  Push "$INSTDIR\WebView2Fixed"
  Call ${PREFIX}YzCheckTree
  Push "$INSTDIR\WebView2Fixed.stage"
  Call ${PREFIX}YzCheckTree
  Push "$INSTDIR\WebView2Fixed.previous"
  Call ${PREFIX}YzCheckTree
!macroend

!macro YZ_CHECK_DIRECTORY PATH
  System::Call 'kernel32::GetFileAttributesW(w "${PATH}") i .r0'
  ${If} $0 != -1
    IntOp $1 $0 & 0x400
    IntOp $0 $0 & 0x10
    ${If} $1 != 0
    ${OrIf} $0 == 0
      SetErrorLevel 2
      Abort "$(YzWebViewPathFailure)"
    ${EndIf}
  ${EndIf}
!macroend

; Check descendants too, so recursive cleanup cannot traverse a user-added
; junction/symlink inside an otherwise ordinary component directory.
!macro YZ_DEFINE_CHECK_TREE PREFIX
Function ${PREFIX}YzCheckTree
  Exch $0
  Push $1
  Push $2
  Push $3
  System::Call 'kernel32::GetFileAttributesW(w r0) i .r3'
  ${If} $3 != -1
    IntOp $1 $3 & 0x400
    ${If} $1 != 0
      SetErrorLevel 2
      Abort "$(YzWebViewPathFailure)"
    ${EndIf}
    IntOp $3 $3 & 0x10
    ${If} $3 != 0
      FindFirst $1 $2 "$0\*"
      ${DoWhile} $2 != ""
        ${If} $2 != "."
        ${AndIf} $2 != ".."
          Push "$0\$2"
          Call ${PREFIX}YzCheckTree
        ${EndIf}
        FindNext $1 $2
      ${Loop}
      FindClose $1
    ${EndIf}
  ${EndIf}
  Pop $3
  Pop $2
  Pop $1
  Pop $0
  ClearErrors
FunctionEnd
!macroend
!insertmacro YZ_DEFINE_CHECK_TREE ""
!insertmacro YZ_DEFINE_CHECK_TREE "un."

!macro YZ_REQUIRE_RUNTIME_FILE FILE
  System::Call 'kernel32::GetFileAttributesW(w "$INSTDIR\WebView2Fixed\${FILE}") i .r0'
  ${If} $0 == -1
    SetErrorLevel 2
    MessageBox MB_OK|MB_ICONSTOP "$(YzWebViewRepair)" /SD IDOK
    Abort
  ${EndIf}
  IntOp $0 $0 & 0x410
  ${If} $0 != 0
    SetErrorLevel 2
    MessageBox MB_OK|MB_ICONSTOP "$(YzWebViewRepair)" /SD IDOK
    Abort
  ${EndIf}
!macroend

; A lean installer must never remove/recreate the component, even when selected.
; Fail before overwriting the app if a selected runtime has missing key files.
Function YzValidateRetainedRuntime
  ${If} $YzWebViewSelected == 1
    !insertmacro YZ_CHECK_RUNTIME_PATHS ""
    !insertmacro YZ_REQUIRE_RUNTIME_FILE "msedgewebview2.exe"
    !insertmacro YZ_REQUIRE_RUNTIME_FILE "msedge.dll"
    !insertmacro YZ_REQUIRE_RUNTIME_FILE "icudtl.dat"
    !insertmacro YZ_REQUIRE_RUNTIME_FILE "resources.pak"
    !insertmacro YZ_REQUIRE_RUNTIME_FILE "yuan-zhou-runtime.json"
  ${EndIf}
FunctionEnd

!macro YZ_INSTALL_WEBVIEW
  !if ${YZ_WEBVIEW_PAYLOAD} == 0
    Call YzValidateRetainedRuntime
  !else
  ${If} $YzWebViewSelected != 1
    IfFileExists "$INSTDIR\WebView2Fixed\*.*" yz_runtime_change
    IfFileExists "$INSTDIR\WebView2Fixed.stage\*.*" yz_runtime_change
    IfFileExists "$INSTDIR\WebView2Fixed.previous\*.*" yz_runtime_change
    IfFileExists "$INSTDIR\webview2-component.enabled" yz_runtime_change
    WriteRegDWORD SHCTX "${MANUPRODUCTKEY}" "IndependentWebView2" 0
    Goto yz_runtime_done
  ${EndIf}
  yz_runtime_change:
  !insertmacro YZ_CHECK_RUNTIME_PATHS ""
  ${If} $YzWebViewSelected == 1
    DetailPrint "$(YzWebViewChoice)"
    ClearErrors
    RMDir /r "$INSTDIR\WebView2Fixed.stage"
    ${If} ${Errors}
      Goto yz_runtime_failed
    ${EndIf}
    SetOutPath "$INSTDIR\WebView2Fixed.stage"
    File /r "${YZ_WEBVIEW_SOURCE}\*"
    ${If} ${Errors}
      Goto yz_runtime_failed
    ${EndIf}
    IfFileExists "$INSTDIR\WebView2Fixed.stage\msedgewebview2.exe" 0 yz_runtime_failed
    IfFileExists "$INSTDIR\WebView2Fixed.stage\yuan-zhou-runtime.json" 0 yz_runtime_failed
    ; Required for Fixed Runtime 120+ AppContainer renderers on Windows 10.
    nsExec::ExecToStack /TIMEOUT=30000 '"$SYSDIR\icacls.exe" "$INSTDIR\WebView2Fixed.stage" /grant *S-1-15-2-2:(OI)(CI)(RX) *S-1-15-2-1:(OI)(CI)(RX)'
    Pop $0
    Pop $1
    ${If} $0 != 0
      Goto yz_runtime_failed
    ${EndIf}
    SetOutPath $INSTDIR
    ClearErrors
    RMDir /r "$INSTDIR\WebView2Fixed.previous"
    ${If} ${Errors}
      Goto yz_runtime_failed
    ${EndIf}
    IfFileExists "$INSTDIR\WebView2Fixed\*.*" 0 yz_runtime_activate
      Rename "$INSTDIR\WebView2Fixed" "$INSTDIR\WebView2Fixed.previous"
      ${If} ${Errors}
        Goto yz_runtime_failed
      ${EndIf}
    yz_runtime_activate:
    ClearErrors
    Rename "$INSTDIR\WebView2Fixed.stage" "$INSTDIR\WebView2Fixed"
    ${If} ${Errors}
      Rename "$INSTDIR\WebView2Fixed.previous" "$INSTDIR\WebView2Fixed"
      Goto yz_runtime_failed
    ${EndIf}
    RMDir /r "$INSTDIR\WebView2Fixed.previous"
    ClearErrors
    FileOpen $0 "$INSTDIR\webview2-component.enabled" w
    ${If} ${Errors}
      Goto yz_runtime_failed
    ${EndIf}
    FileWrite $0 "1"
    FileClose $0
    ${If} ${Errors}
      Goto yz_runtime_failed
    ${EndIf}
    WriteRegDWORD SHCTX "${MANUPRODUCTKEY}" "IndependentWebView2" 1
  ${Else}
    ClearErrors
    RMDir /r "$INSTDIR\WebView2Fixed"
    RMDir /r "$INSTDIR\WebView2Fixed.stage"
    RMDir /r "$INSTDIR\WebView2Fixed.previous"
    Delete "$INSTDIR\webview2-component.enabled"
    ${If} ${Errors}
      Goto yz_runtime_failed
    ${EndIf}
    WriteRegDWORD SHCTX "${MANUPRODUCTKEY}" "IndependentWebView2" 0
  ${EndIf}
  Goto yz_runtime_done
  yz_runtime_failed:
    SetErrorLevel 2
    MessageBox MB_OK|MB_ICONSTOP "$(YzWebViewFailure)" /SD IDOK
    Abort "$(YzWebViewFailure)"
  yz_runtime_done:
  !endif
!macroend

!macro YZ_UNINSTALL_WEBVIEW
  ${If} $UpdateMode != 1
    IfFileExists "$INSTDIR\WebView2Fixed\*.*" yz_runtime_uninstall
    IfFileExists "$INSTDIR\WebView2Fixed.stage\*.*" yz_runtime_uninstall
    IfFileExists "$INSTDIR\WebView2Fixed.previous\*.*" yz_runtime_uninstall
    IfFileExists "$INSTDIR\webview2-component.enabled" yz_runtime_uninstall
    DeleteRegValue SHCTX "${MANUPRODUCTKEY}" "IndependentWebView2"
    Goto yz_runtime_uninstall_done
    yz_runtime_uninstall:
    !insertmacro YZ_CHECK_RUNTIME_PATHS "un."
    ClearErrors
    RMDir /r "$INSTDIR\WebView2Fixed"
    RMDir /r "$INSTDIR\WebView2Fixed.stage"
    RMDir /r "$INSTDIR\WebView2Fixed.previous"
    Delete "$INSTDIR\webview2-component.enabled"
    ${If} ${Errors}
      SetErrorLevel 2
      Abort "$(YzWebViewPathFailure)"
    ${EndIf}
    DeleteRegValue SHCTX "${MANUPRODUCTKEY}" "IndependentWebView2"
  ${EndIf}
  yz_runtime_uninstall_done:
!macroend
