@echo off
setlocal
set "readerd_pdf_arg="
if not "%~1"=="" set "readerd_pdf_arg=%~f1"
cd /d "%~dp0"
if exist "release\0.2.3\win-unpacked\ReaderD.exe" (
  if defined readerd_pdf_arg (
    start "" "release\0.2.3\win-unpacked\ReaderD.exe" "%readerd_pdf_arg%"
  ) else (
    start "" "release\0.2.3\win-unpacked\ReaderD.exe"
  )
) else (
  call npm.cmd start
)
