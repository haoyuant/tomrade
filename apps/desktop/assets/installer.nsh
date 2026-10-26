; An update runs this installer with its window, so the person sees it working (src/updater.ts).
; These keep that window to the progress alone.

; The mode of the copy being updated, instead of asking again whom Tomrade is for.
!macro customInstallMode
  ${if} ${isUpdated}
    ${if} $installMode == "all"
      StrCpy $isForceMachineInstall "1"
    ${else}
      StrCpy $isForceCurrentInstall "1"
    ${endif}
  ${endif}
!macroend

; No finish page after an update: the installer closes and, when the app asked for it, starts the new version.
!macro customFinishPage
  Function tomradeFinishPre
    ${if} ${isUpdated}
      ${if} ${isForceRun}
        HideWindow
        ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "--updated"
      ${endif}
      Abort
    ${endif}
  FunctionEnd

  Function tomradeStartApp
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" ""
  FunctionEnd

  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_FUNCTION tomradeStartApp
  !define MUI_PAGE_CUSTOMFUNCTION_PRE tomradeFinishPre
  !insertmacro MUI_PAGE_FINISH
!macroend

; The install section runs with SetDetailsPrint none, so on its own it never says what it is doing.
; Each step below names itself above the progress bar and in the details list.

; English for every installer language that has no words of its own here.
!macro tomradeLangString NAME EN ZH
  LangString ${NAME} 1033 "${EN}"
  LangString ${NAME} 2052 "${ZH}"
  !insertmacro tomradeLangStringIn ${NAME} "${EN}" 1031 1036 3082 1028 1041 1042 1040 1043 1030 1053 1044 1035
  !insertmacro tomradeLangStringIn ${NAME} "${EN}" 1049 2070 1046 1045 1058 1029 1051 1038 1025 1055 1054 1066
!macroend

!macro tomradeLangStringIn NAME TEXT L1 L2 L3 L4 L5 L6 L7 L8 L9 L10 L11 L12
  LangString ${NAME} ${L1} "${TEXT}"
  LangString ${NAME} ${L2} "${TEXT}"
  LangString ${NAME} ${L3} "${TEXT}"
  LangString ${NAME} ${L4} "${TEXT}"
  LangString ${NAME} ${L5} "${TEXT}"
  LangString ${NAME} ${L6} "${TEXT}"
  LangString ${NAME} ${L7} "${TEXT}"
  LangString ${NAME} ${L8} "${TEXT}"
  LangString ${NAME} ${L9} "${TEXT}"
  LangString ${NAME} ${L10} "${TEXT}"
  LangString ${NAME} ${L11} "${TEXT}"
  LangString ${NAME} ${L12} "${TEXT}"
!macroend

!insertmacro tomradeLangString tomradeStepClosing "Making sure ${PRODUCT_NAME} is closed..." "正在确认 ${PRODUCT_NAME} 已关闭…"
!insertmacro tomradeLangString tomradeStepRemoving "Removing the previous version (this can take a few minutes)..." "正在移除旧版本（可能需要几分钟）…"
!insertmacro tomradeLangString tomradeStepUnpacking "Unpacking files..." "正在解压文件…"
!insertmacro tomradeLangString tomradeStepCopying "Copying files to the install folder..." "正在把文件复制到安装目录…"
!insertmacro tomradeLangString tomradeStepShortcuts "Creating shortcuts..." "正在创建快捷方式…"
!insertmacro tomradeLangString tomradeStepDone "Done" "完成"

!macro tomradeStep TEXT
  SetDetailsPrint both
  DetailPrint "${TEXT}"
  SetDetailsPrint lastused
!macroend

!macro customHeader
  !ifndef BUILD_UNINSTALLER
    Var tomradeUnpacked
    Var tomradeBar

    ; Nsis7z::ExtractWithCallback calls this with the bytes done and the total.
    Function tomradeUnpackProgress
      Exch $0
      Exch
      Exch $1
      ${if} $1 > 0
        System::Int64Op $0 * 100
        Pop $0
        System::Int64Op $0 / $1
        Pop $0
        ${if} $0 != $tomradeUnpacked
          StrCpy $tomradeUnpacked $0
          SetDetailsPrint textonly
          DetailPrint "$(tomradeStepUnpacking) $0%"
          SetDetailsPrint lastused
        ${endif}
      ${endif}
      Pop $1
      Pop $0
    FunctionEnd
  !endif
!macroend

; What allowOnlyOneInstallerInstance.nsh brings in for _CHECK_APP_RUNNING only while this macro is undefined.
!include "getProcessInfo.nsh"
Var pid

!macro customCheckAppRunning
  !ifndef BUILD_UNINSTALLER
    !insertmacro tomradeStep "$(tomradeStepClosing)"
    ; The section's macros are defined by now and not yet used: swap in the unpacking that keeps the bar going forward.
    !include "installer-unpack.nsh"
  !endif
  !insertmacro IS_POWERSHELL_AVAILABLE
  !insertmacro _CHECK_APP_RUNNING
  !ifndef BUILD_UNINSTALLER
    ReadRegStr $0 SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" UninstallString
    ${if} $0 != ""
      !insertmacro tomradeStep "$(tomradeStepRemoving)"
    ${endif}
  !endif
!macroend

; electron-builder's own check of the old version's uninstall, followed by the next step's name.
!macro customUnInstallCheck
  ${if} ${errors}
    DetailPrint `Uninstall was not successful. Not able to launch uninstaller!`
  ${elseif} $R0 != 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "$(uninstallFailed): $R0"
    DetailPrint `Uninstall was not successful. Uninstaller error code: $R0.`
    SetErrorLevel 2
    Quit
  ${endif}
  !insertmacro tomradeStep "$(tomradeStepUnpacking)"
!macroend

!macro customFiles_x64
  !insertmacro tomradeStep "$(tomradeStepShortcuts)"
!macroend

!macro customFiles_arm64
  !insertmacro tomradeStep "$(tomradeStepShortcuts)"
!macroend

!macro customFiles_ia32
  !insertmacro tomradeStep "$(tomradeStepShortcuts)"
!macroend

!macro customInstall
  !insertmacro tomradeStep "$(tomradeStepDone)"
!macroend
