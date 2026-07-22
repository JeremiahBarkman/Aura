; ---------------------------------------------------------------------------
; Aura NSIS installer customization
;
; Registers the virtual-camera media source (VCamSampleSource.dll) with COM.
;
; Windows resolves the virtual camera through a COM CLSID, so simply copying
; the DLL is not enough - without this registration the camera either does not
; appear at all, or an app that remembers a stale entry renders a BLACK image.
;
; This is why the install requires admin (perMachine): regsvr32 writes to
; HKLM\SOFTWARE\Classes. Aura's own config and data stay per-user in %APPDATA%.
; ---------------------------------------------------------------------------

!macro customInstall
  DetailPrint "Registering the Aura virtual camera..."

  ; /s = silent: no message boxes during an unattended install.
  ExecWait '"$SYSDIR\regsvr32.exe" /s "$INSTDIR\resources\native\VCamSampleSource.dll"' $0

  StrCmp $0 "0" registered failed

  failed:
    DetailPrint "Virtual camera registration FAILED (regsvr32 exit code: $0)."
    DetailPrint "Aura will run, but its virtual camera will not be available"
    DetailPrint "to other apps until this is registered."
    Goto done

  registered:
    DetailPrint "Aura virtual camera registered."

  done:
!macroend

!macro customUnInstall
  DetailPrint "Unregistering the Aura virtual camera..."

  ; Leaving a dangling CLSID behind would point other apps at a DLL that no
  ; longer exists - exactly the stale-registration black screen we are fixing.
  ExecWait '"$SYSDIR\regsvr32.exe" /u /s "$INSTDIR\resources\native\VCamSampleSource.dll"' $0

  DetailPrint "Virtual camera unregistered (exit code: $0)."
!macroend
