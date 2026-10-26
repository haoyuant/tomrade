; electron-builder's extractUsing7za (templates/nsis/include/extractAppPackage.nsh), changed so the
; progress bar never goes backwards: Nsis7z runs the bar it finds (control 1004 of the page) from 0 to
; 100%, and the section then set it back to where it was. With the bar's id hidden while it unpacks,
; Nsis7z finds none, the section's own progress (which holds the bar's handle) goes on, and the step's
; text counts the percentage instead. Copying into the install folder names itself too.
; Included from customCheckAppRunning (installer.nsh), after the template defines the macro and before it is used.

!macro tomradeUnpack FILE
  FindWindow $tomradeBar "#32770" "" $HWNDPARENT
  GetDlgItem $tomradeBar $tomradeBar 1004
  System::Call "user32::SetWindowLong(p $tomradeBar, i -12, i 0)"
  GetFunctionAddress $R1 tomradeUnpackProgress
  Nsis7z::ExtractWithCallback "${FILE}" $R1
  System::Call "user32::SetWindowLong(p $tomradeBar, i -12, i 1004)"
!macroend

!macroundef extractUsing7za
!macro extractUsing7za FILE
  Push $OUTDIR
  CreateDirectory "$PLUGINSDIR\7z-out"
  ClearErrors
  SetOutPath "$PLUGINSDIR\7z-out"
  !insertmacro tomradeUnpack "${FILE}"
  Pop $R0
  SetOutPath $R0

  !insertmacro tomradeStep "$(tomradeStepCopying)"

  # Retry counter
  StrCpy $R1 0

  LoopExtract7za:
    IntOp $R1 $R1 + 1

    # Attempt to copy files in atomic way
    CopyFiles /SILENT "$PLUGINSDIR\7z-out\*" $OUTDIR
    IfErrors 0 DoneExtract7za

    DetailPrint `Can't modify "${PRODUCT_NAME}"'s files.`
    ${if} $R1 < 5
      # Try copying a few times before asking for a user action.
      Goto RetryExtract7za
    ${else}
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDRETRY IDCANCEL AbortExtract7za
    ${endIf}

    # As an absolutely last resort after a few automatic attempts and user
    # intervention - we will just overwrite everything with `Nsis7z::Extract`
    # even though it is not atomic and will ignore errors.

    # Clear the temporary folder first to make sure we don't use twice as
    # much disk space.
    RMDir /r "$PLUGINSDIR\7z-out"

    !insertmacro tomradeStep "$(tomradeStepUnpacking)"
    !insertmacro tomradeUnpack "${FILE}"
    Goto DoneExtract7za

  AbortExtract7za:
    Quit

  RetryExtract7za:
    Sleep 1000
    Goto LoopExtract7za

  DoneExtract7za:
!macroend
