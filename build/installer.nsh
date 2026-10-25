; Only installed copies use AppData. ZIP and single-file portable copies keep
; their existing ReaderD-data directory beside the executable.
!macro customInstall
  Push $0
  FileOpen $0 "$INSTDIR\readerd-installed" w
  FileWrite $0 "ReaderD installed application"
  FileClose $0
  Pop $0
!macroend

!macro customUnInstall
  Delete "$INSTDIR\readerd-installed"
!macroend
