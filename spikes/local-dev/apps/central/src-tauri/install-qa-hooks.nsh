; SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
; Only package-central-qa.mjs supplies the reviewed workspace installation path.
; The QA uninstaller preserves configuration and DPAPI data for reinstall checks.
; utils.nsh is included before installerHooks. Replace Tauri's second check too:
; a process starting between checks must never reach its automatic kill branch.
!ifmacrodef CheckIfAppIsRunning
  !macroundef CheckIfAppIsRunning
!endif
!macro CheckIfAppIsRunning executableName productName
  !insertmacro CENTRAL_QA_REQUIRE_STOPPED
!macroend

!macro CENTRAL_QA_RESTORE_SCAN_REGISTERS
  Pop $9
  Pop $8
  Pop $7
  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
!macroend

!macro CENTRAL_QA_REQUIRE_STOPPED
  ; NSIS itself is x86 even when bundling an x64 application. PROCESSENTRY32W
  ; is 556 bytes, with the executable name at offset 36 on this NSIS runtime.
  ; Snapshot every session: the QA basename is unique, and no process is killed.
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  Push $7
  Push $8
  Push $9
  StrCpy $9 1
  StrCpy $7 0
  System::Call 'kernel32::CreateToolhelp32Snapshot(i 2, i 0) p .r0'
  ${If} $0 != -1
  ${AndIf} $0 != 0
    System::Alloc 556
    Pop $1
    ${If} $1 != 0
      System::Call '*$1(i 556)'
      System::Call 'kernel32::Process32FirstW(p r0, p r1) i .r2 ?e'
      Pop $6
      ${If} $2 != 0
        StrCpy $9 2
        ${Do}
          IntOp $7 $7 + 1
          ${If} $7 > 4096
            StrCpy $9 1
            ${ExitDo}
          ${EndIf}
          IntOp $3 $1 + 36
          System::Call '*$3(&w260 .r4)'
          ${If} $4 == "${MAINBINARYNAME}.exe"
            StrCpy $9 0
            ${ExitDo}
          ${EndIf}
          System::Call 'kernel32::Process32NextW(p r0, p r1) i .r2 ?e'
          Pop $6
          ${If} $2 = 0
            ${If} $6 != 18
              StrCpy $9 1
            ${EndIf}
            ${ExitDo}
          ${EndIf}
        ${Loop}
      ${EndIf}
      System::Free $1
    ${EndIf}
    System::Call 'kernel32::CloseHandle(p r0)'
  ${EndIf}
  ${If} $9 != 2
    !insertmacro CENTRAL_QA_RESTORE_SCAN_REGISTERS
    SetErrorLevel 10
    Abort "请先关闭中央管理安装验收窗口，等待中央服务退出后重试。"
  ${EndIf}
  !insertmacro CENTRAL_QA_RESTORE_SCAN_REGISTERS
!macroend

!macro CENTRAL_QA_REQUIRE_DIRECTORY
  !ifndef CENTRAL_QA_INSTALL_DIR
    !error "Build the isolated QA installer through package-central-qa.mjs."
  !endif
  GetFullPathName $R8 "$INSTDIR"
  GetFullPathName $R9 "${CENTRAL_QA_INSTALL_DIR}"
  ${If} $R8 != $R9
    SetErrorLevel 11
    Abort "安装验收包只能使用构建记录中的独立验收目录。"
  ${EndIf}
  ; Check every existing ancestor as well as the final installation directory.
  ${Do}
    System::Call 'kernel32::GetFileAttributesW(w r18) i .r19'
    ${If} $R9 = -1
      SetErrorLevel 11
      Abort "无法确认安装验收目录，请检查访问权限后重试。"
    ${EndIf}
    IntOp $R9 $R9 & 0x400
    ${If} $R9 != 0
      SetErrorLevel 11
      Abort "安装验收目录及其父目录不能是链接或目录联接。"
    ${EndIf}
    ${GetParent} "$R8" $R9
    ${If} $R9 == ""
    ${OrIf} $R9 == $R8
      ${ExitDo}
    ${EndIf}
    StrCpy $R8 $R9
  ${Loop}
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro CENTRAL_QA_REQUIRE_DIRECTORY
  !insertmacro CENTRAL_QA_REQUIRE_STOPPED
  !insertmacro CENTRAL_QA_REQUIRE_VERSION
!macroend

!macro CENTRAL_QA_REQUIRE_VERSION
  ; Silent installs skip PageReinstall, where the stock template computes the
  ; downgrade result. Check the QA key directly before copying any product file.
  Push $0
  Push $1
  Push $2
  StrCpy $2 12
  System::Call 'advapi32::RegOpenKeyExW(p 0x80000001, w "${UNINSTKEY}", i 0, i 0x20119, *p .r0) i .r1'
  ${If} $1 = 2
    ; ERROR_FILE_NOT_FOUND is the only accepted absence result.
    StrCpy $2 0
  ${ElseIf} $1 = 0
    System::Call 'advapi32::RegCloseKey(p r0)'
    SetRegView 64
    ClearErrors
    ReadRegStr $0 HKCU "${UNINSTKEY}" "DisplayVersion"
    ${IfNot} ${Errors}
      ${If} $0 == "0.1.0"
      ${OrIf} $0 == "0.1.1"
        ${VersionCompare} "${VERSION}" "$0" $1
        ${If} $1 = 0
        ${OrIf} $1 = 1
          StrCpy $2 0
        ${EndIf}
      ${EndIf}
    ${EndIf}
  ${EndIf}
  ${If} $2 != 0
    Pop $2
    Pop $1
    Pop $0
    SetErrorLevel 12
    Abort "安装验收包不允许降级；已有安装版本无法确认时也会停止安装。"
  ${EndIf}
  Pop $2
  Pop $1
  Pop $0
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro CENTRAL_QA_REQUIRE_DIRECTORY
  !insertmacro CENTRAL_QA_REQUIRE_STOPPED
  ; The stock template reads this later. Retention also applies to silent upgrades.
  StrCpy $DeleteAppDataCheckboxState 0
!macroend
