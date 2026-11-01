; oh-my-md installer welcome/finish copy (en + zh).
; Included via bundle.windows.nsis.installerHooks before MUI pages are inserted.

LangString OMD_WELCOME_TITLE ${LANG_ENGLISH} "Welcome to oh-my-md Setup"
LangString OMD_WELCOME_TITLE ${LANG_SIMPCHINESE} "欢迎使用 oh-my-md 安装向导"

LangString OMD_WELCOME_TEXT ${LANG_ENGLISH} "This will install oh-my-md on your computer.$\r$\n$\r$\nClick Next to continue, or Cancel to exit."
LangString OMD_WELCOME_TEXT ${LANG_SIMPCHINESE} "欢迎使用 oh-my-md 安装向导。$\r$\n点击「下一步」开始安装，或点击「取消」退出。"

!define MUI_WELCOMEPAGE_TITLE "$(OMD_WELCOME_TITLE)"
!define MUI_WELCOMEPAGE_TEXT "$(OMD_WELCOME_TEXT)"

LangString OMD_FINISH_TITLE ${LANG_ENGLISH} "Completing oh-my-md Setup"
LangString OMD_FINISH_TITLE ${LANG_SIMPCHINESE} "完成 oh-my-md 安装"

LangString OMD_FINISH_TEXT ${LANG_ENGLISH} "oh-my-md has been installed on your computer.$\r$\n$\r$\nClick Finish to close this wizard."
LangString OMD_FINISH_TEXT ${LANG_SIMPCHINESE} "oh-my-md 已安装完成。$\r$\n$\r$\n点击「完成」关闭安装向导。"

!define MUI_FINISHPAGE_TITLE "$(OMD_FINISH_TITLE)"
!define MUI_FINISHPAGE_TEXT "$(OMD_FINISH_TEXT)"

; Silent installs cannot run the interactive MSI migration from the reinstall
; page (Tauri built-in WixMode path), and unprivileged currentUser installs
; cannot uninstall a per-machine MSI anyway. Fail with a distinct exit code
; instead of silently creating a second side-by-side installation.
; Documented in docs/guides/windows-installer.md: 1603 = MSI remnant detected.
LangString OMD_SILENT_MSI_BLOCK ${LANG_ENGLISH} "An MSI installation of oh-my-md was detected. Silent installs cannot migrate it. Run the setup wizard once (it will guide you through removing the MSI), then retry."
LangString OMD_SILENT_MSI_BLOCK ${LANG_SIMPCHINESE} "检测到旧版 oh-my-md 的 MSI 安装。静默安装无法完成迁移：请手动运行一次安装向导（会引导卸载 MSI）后重试。"

!macro NSIS_HOOK_PREINSTALL
  ; Guard silent installs only. Interactive and passive installs are handled
  ; by the built-in WixMode migration on the reinstall page; doing the same
  ; work here would double-prompt the user.
  ${If} ${Silent}
    ; Explicit 64-bit registry view: the installer is a 32-bit process and
    ; the MSI (built as x64) registers in the 64-bit view. The template's
    ; .onInit SetContext already sets this for ARCH=x64; restate it here so
    ; the hook stays correct independent of that initialization order. Do
    ; NOT reset to 32 afterwards — the rest of the install expects 64.
    SetRegView 64
    ; Mirror the built-in WixMode detection exactly (DisplayName+Publisher
    ; match, then msiexec in UninstallString) so the two paths never disagree.
    StrCpy $0 0
    omd_msi_loop:
      EnumRegKey $1 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall" $0
      StrCmp $1 "" omd_msi_done
      IntOp $0 $0 + 1
      ReadRegStr $R0 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$1" "DisplayName"
      ReadRegStr $R1 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$1" "Publisher"
      StrCmp "$R0$R1" "${PRODUCTNAME}${MANUFACTURER}" 0 omd_msi_loop
      ReadRegStr $R0 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$1" "UninstallString"
      ${StrCase} $R1 $R0 "L"
      ${StrLoc} $R0 $R1 "msiexec" ">"
      StrCmp $R0 0 0 omd_msi_loop
      ; Signal MSI remnant to the caller. SetErrorLevel alone is
      ; overwritten by the process exit path, so stash the code and
      ; re-apply it from .onInstFailed below.
      StrCpy $OMD_EXIT 1603
      DetailPrint "$(OMD_SILENT_MSI_BLOCK)"
      Abort
    omd_msi_done:
  ${EndIf}
!macroend

; Custom exit code for silent MSI-remnant blocking; empty otherwise.
Var OMD_EXIT

; Abort inside a section raises install-failed; re-assert our exit code
; here because the default failure path resets it.
Function .onInstFailed
  ${If} $OMD_EXIT != ""
    SetErrorLevel $OMD_EXIT
  ${EndIf}
FunctionEnd
