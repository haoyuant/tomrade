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
