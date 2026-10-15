; NSIS hooks for Music Creator Studio YuE2.
; The data root (ComfyUI runtime, models, LLM) is downloaded by the app after installation and its
; location is recorded in the registry by the app. On uninstall we offer to delete what the app created there.
;
; An upgrade (a newer setup.exe over an installed version, "uninstall before installing") runs the OLD
; version's uninstaller as a normal interactive uninstall ($UpdateMode is 0 on that path), so this hook
; must be safe for it: settings, library and API keys go only with Tauri's "delete app data" checkbox
; (off by default), and both folder prompts default to No.
;
; The data root and the song folder are folders the user picked, possibly shared with other files
; (D:\AI, the Music folder), so nothing ever removes them recursively: only the entries the app itself creates,
; under names only this app uses (runtime\ComfyUI_windows_portable, cache\sep_work, <date>\<time>_<id> song
; folders ...), are removed, then the folders themselves only when they are left empty.
; No recursive delete follows a junction or symbolic link (a model or cache folder shared with other tools
; through mklink /J): NSIS's RMDir /r would empty its target, so McsRMDirR uses "rd /s", which removes a link
; without entering it, and removes a link given to it directly as just the link.

!include LogicLib.nsh

; Set by McsCleanPath: 1 when it gave "" because the path's 8.3 short names cannot be made long (McsLongNames), so
; the path cannot be compared with the data root's folders, else 0. Read right after the call: what one cleaning gave
; decides (McsToolsChoice, McsFormerInDataRoot).
Var McsCleanUnsure

!macro NSIS_HOOK_PREINSTALL
!macroend

!macro NSIS_HOOK_POSTINSTALL
!macroend

!macro NSIS_HOOK_PREUNINSTALL
!macroend

; Remove a folder tree the app created without following links: a junction / symbolic link itself is only
; unlinked; otherwise cmd's "rd /s /q" on the extended-length path (the runtime holds files ~240 characters
; below the data root, more than MAX_PATH for any root longer than ~19 characters while Windows long paths are
; off). The path reaches cmd through an environment variable, so "%", "&", "!" or "^" in it are never parsed.
; There is deliberately no RMDir /r fallback (it follows junctions): a tree rd cannot remove stays.
; PATH must be normalised and absolute (McsCleanPath).
!macro McsRMDirR UN PATH
  Push "${PATH}"
  Call ${UN}McsRMDirR
!macroend

; In McsDeleteDataRoot: remove PATH when it is a junction or symbolic link (the link only); $R2 becomes 1 when a
; link stays there.
!macro McsUnlink UN PATH
  Push "${PATH}"
  Call ${UN}McsUnlink
  Pop $R1
  IntOp $R2 $R2 | $R1
!macroend

; In McsDeleteDataRoot: delete the files at the top of the folder PATH that are named as the app names its files
; there (KIND "staged": McsIsStagedName, "output": McsIsOutputName). PATH must be unlinked first (McsUnlink).
!macro McsDeleteOwnFiles UN PATH KIND
  Push "${PATH}"
  Push "${KIND}"
  Call ${UN}McsDeleteOwnFiles
!macroend

; In McsOutputInDataRoot: $R2 = 1 when $R1 is the folder $R0\DIR or lies inside it.
!macro McsIfInside DIR
  ${If} $R1 == "$R0\${DIR}"
    StrCpy $R2 1
  ${EndIf}
  StrLen $R3 "$R0\${DIR}\"
  StrCpy $R3 $R1 $R3
  ${If} $R3 == "$R0\${DIR}\"
    StrCpy $R2 1
  ${EndIf}
!macroend

!macro McsHookFunctions UN
  Function ${UN}McsRMDirR
    Exch $R0
    Push $R1
    Push $R2
    StrCpy $R1 $R0 2
    ${If} $R1 == "\\"
      StrCpy $R1 $R0 "" 2
      StrCpy $R1 "\\?\UNC\$R1"
    ${Else}
      StrCpy $R1 "\\?\$R0"
    ${EndIf}
    System::Call 'kernel32::GetFileAttributesW(w "$R1") i .R2'
    ${If} $R2 = -1
      Goto mcs_rmdir_done
    ${EndIf}
    IntOp $R2 $R2 & 0x400 ; FILE_ATTRIBUTE_REPARSE_POINT
    ${If} $R2 <> 0
      ; A junction or symbolic link: remove the link, never what it points to (RemoveDirectoryW: NSIS's RMDir does
      ; nothing with a \\?\UNC\ path).
      System::Call 'kernel32::RemoveDirectoryW(w R1) i .R2'
      RMDir "$R0"
      Goto mcs_rmdir_done
    ${EndIf}
    System::Call 'kernel32::SetEnvironmentVariableW(w "MCS_DEL", w "$R1") i .R2'
    ; /d: no AutoRun commands; /v:off: "!" is never expanded, whatever the registry says.
    nsExec::Exec '"$SYSDIR\cmd.exe" /d /v:off /c rd /s /q "%MCS_DEL%"'
    Pop $R2
    System::Call 'kernel32::SetEnvironmentVariableW(w "MCS_DEL", p 0) i .R2'
    mcs_rmdir_done:
    Pop $R2
    Pop $R1
    Pop $R0
  FunctionEnd

  ; Stack in: a normalised absolute path. A junction or symbolic link there is removed, never what it points to.
  ; Stack out: 1 when a link is still there (it could not be removed), else 0 (also when there is nothing).
  Function ${UN}McsUnlink
    Exch $R0
    Push $R1
    Push $R2
    StrCpy $R1 $R0 2
    ${If} $R1 == "\\"
      StrCpy $R1 $R0 "" 2
      StrCpy $R1 "\\?\UNC\$R1"
    ${Else}
      StrCpy $R1 "\\?\$R0"
    ${EndIf}
    System::Call 'kernel32::GetFileAttributesW(w "$R1") i .R2'
    ${If} $R2 <> -1
      IntOp $R2 $R2 & 0x400 ; FILE_ATTRIBUTE_REPARSE_POINT
      ${If} $R2 <> 0
        ; (RemoveDirectoryW: NSIS's RMDir does nothing with a \\?\UNC\ path)
        System::Call 'kernel32::RemoveDirectoryW(w R1) i .R2'
        RMDir "$R0"
        System::Call 'kernel32::GetFileAttributesW(w "$R1") i .R2'
      ${Else}
        StrCpy $R2 -1
      ${EndIf}
    ${EndIf}
    ${If} $R2 = -1
      StrCpy $R0 0
    ${Else}
      StrCpy $R0 1
    ${EndIf}
    Pop $R2
    Pop $R1
    Exch $R0
  FunctionEnd

  ; Stack in: a path. Stack out: its parent ("" when it has no "\").
  Function ${UN}McsParent
    Exch $R0
    Push $R1
    Push $R2
    StrLen $R1 $R0
    ${Do}
      IntOp $R1 $R1 - 1
      ${If} $R1 < 0
        StrCpy $R0 ""
        ${ExitDo}
      ${EndIf}
      StrCpy $R2 $R0 1 $R1
      ${If} $R2 == "\"
        StrCpy $R0 $R0 $R1
        ${ExitDo}
      ${EndIf}
    ${Loop}
    Pop $R2
    Pop $R1
    Exch $R0
  FunctionEnd

  ; Stack in: a path. Stack out: 1 when it is the folder that holds the user profiles (X:\Users, or wherever
  ; the parent of $PROFILE is), else 0.
  Function ${UN}McsIsUsersDir
    Exch $R0
    Push $R1
    Push $R2
    StrCpy $R2 0
    StrLen $R1 $R0
    ${If} $R1 = 8
      StrCpy $R1 $R0 2 1
      ${If} $R1 == ":\"
        StrCpy $R1 $R0 "" 3
        ${If} $R1 == "Users"
          StrCpy $R2 1
        ${EndIf}
      ${EndIf}
    ${EndIf}
    Push $PROFILE
    Call ${UN}McsParent
    Pop $R1
    ${If} $R1 != ""
    ${AndIf} $R0 == $R1
      StrCpy $R2 1
    ${EndIf}
    StrCpy $R0 $R2
    Pop $R2
    Pop $R1
    Exch $R0
  FunctionEnd

  ; Stack in: a normalised path without a trailing "\". Stack out: 1 when it is a user folder the settings page
  ; calls a shared user folder (isShellFolder in src/config/rules.ts; keep the two in step, checked by the
  ; config.rs test uninstaller_protects_every_shell_folder): the profiles folder, a profile (any user, Public
  ; too) or a profile's Documents / Music / Desktop / Downloads / Pictures / Videos / OneDrive* folder. Text
  ; checks, so a known folder moved elsewhere (OneDrive folder backup) is still covered by McsCleanPath's own
  ; comparisons with $DOCUMENTS, $MUSIC ...
  Function ${UN}McsIsShellPath
    Exch $R0
    Push $R1
    Push $R2
    Push $R3
    StrCpy $R3 0
    Push $R0
    Call ${UN}McsIsUsersDir
    Pop $R1
    ${If} $R1 = 1
      StrCpy $R3 1
      Goto mcs_shell_done
    ${EndIf}
    Push $R0
    Call ${UN}McsParent
    Pop $R1
    Push $R1
    Call ${UN}McsIsUsersDir
    Pop $R2
    ${If} $R2 = 1
      StrCpy $R3 1
      Goto mcs_shell_done
    ${EndIf}
    ; the last component and the grandparent
    StrLen $R2 $R1
    IntOp $R2 $R2 + 1
    StrCpy $R2 $R0 "" $R2
    Push $R1
    Call ${UN}McsParent
    Pop $R1
    Push $R1
    Call ${UN}McsIsUsersDir
    Pop $R1
    ${If} $R1 = 1
      StrCpy $R1 $R2 8
      ${If} $R2 == "Documents"
      ${OrIf} $R2 == "Music"
      ${OrIf} $R2 == "Desktop"
      ${OrIf} $R2 == "Downloads"
      ${OrIf} $R2 == "Pictures"
      ${OrIf} $R2 == "Videos"
      ${OrIf} $R1 == "OneDrive"
        StrCpy $R3 1
      ${EndIf}
    ${EndIf}
    mcs_shell_done:
    StrCpy $R0 $R3
    Pop $R3
    Pop $R2
    Pop $R1
    Exch $R0
  FunctionEnd

  ; Stack in: a path. Stack out: its full path (GetFullPathNameW: "/" becomes "\", "." and ".." are resolved), or ""
  ; when it is too long. No disk access, and no MAX_PATH limit (NSIS's GetFullPathName has one).
  Function ${UN}McsFullPath
    Exch $R0
    Push $R1
    Push $R2
    System::Call 'kernel32::GetFullPathNameW(w R0, i ${NSIS_MAX_STRLEN}, w .R1, p 0) i .R2'
    ${If} $R2 = 0
    ${OrIf} $R2 >= ${NSIS_MAX_STRLEN}
      StrCpy $R0 ""
    ${Else}
      StrCpy $R0 $R1
    ${EndIf}
    Pop $R2
    Pop $R1
    Exch $R0
  FunctionEnd

  ; Stack in: an absolute path. Stack out: 1 when a folder this account can list is there (also through a link), else
  ; 0: a missing folder, a file, a link whose target is gone or a folder it cannot list counts as not there, as with
  ; FileExists "<folder>\*.*". Listed through the extended-length path: the folder may lie more than MAX_PATH below
  ; the drive (a long data root).
  Function ${UN}McsIsDir
    Exch $R0
    Push $R1
    Push $R2
    Push $R0
    Call ${UN}McsFullPath
    Pop $R0
    ${If} $R0 == ""
      StrCpy $R0 0
      Goto mcs_isdir_done
    ${EndIf}
    ; without a trailing "\" before "\*" (the \\?\ form is taken as it is)
    mcs_isdir_strip:
      StrCpy $R1 $R0 1 -1
      ${If} $R1 == "\"
        StrCpy $R0 $R0 -1
        Goto mcs_isdir_strip
      ${EndIf}
    StrCpy $R1 $R0 2
    ${If} $R1 == "\\"
      StrCpy $R1 $R0 "" 2
      StrCpy $R1 "\\?\UNC\$R1"
    ${Else}
      StrCpy $R1 "\\?\$R0"
    ${EndIf}
    ClearErrors
    FindFirst $R2 $R0 "$R1\*"
    ${If} ${Errors}
      StrCpy $R0 0
    ${Else}
      FindClose $R2
      StrCpy $R0 1
    ${EndIf}
    mcs_isdir_done:
    Pop $R2
    Pop $R1
    Exch $R0
  FunctionEnd

  ; Stack in: a full path of a folder that is there (McsIsDir). Stack out: the path with its 8.3 short names made long
  ; ("MCSDAT~1" as on disk), so it is compared with the data root's folders by the same names; "" when a name cannot be
  ; made long, or the long names would not fit in an NSIS string (the path cannot be compared then). Only a name with a
  ; "~" (every 8.3 short name Windows makes has one) is looked up, in the folder that holds it, or else by opening the
  ; folder it names and asking for its normalized path (the folder that holds it may not be listable by this account,
  ; as a share's home folders root): no other folder on the way is listed (a server may not answer).
  Function ${UN}McsLongNames
    Exch $R0
    Push $R1
    Push $R2
    Push $R3
    Push $R4
    Push $R5
    Push $R6
    System::Call 'shlwapi::StrChrW(w R0, i 126) p .R1'
    ${If} $R1 = 0
      Goto mcs_long_done
    ${EndIf}
    ; $R5: the start, never looked up ("C:", "\\server\share"); $R2: the names after it ("\name\name", or "")
    StrCpy $R3 2
    StrCpy $R2 $R0 2
    ${If} $R2 == "\\"
      StrCpy $R4 0
      ${Do}
        StrCpy $R2 $R0 1 $R3
        ${IfThen} $R2 == "" ${|} ${ExitDo} ${|}
        ${If} $R2 == "\"
          IntOp $R4 $R4 + 1
          ${IfThen} $R4 = 2 ${|} ${ExitDo} ${|}
        ${EndIf}
        IntOp $R3 $R3 + 1
      ${Loop}
    ${EndIf}
    StrCpy $R5 $R0 $R3
    StrCpy $R2 $R0 "" $R3
    ${DoWhile} $R2 != ""
      ; $R3: the name after the "\" $R2 starts with; $R2: what follows it
      StrCpy $R4 1
      ${Do}
        StrCpy $R3 $R2 1 $R4
        ${IfThen} $R3 == "" ${|} ${ExitDo} ${|}
        ${IfThen} $R3 == "\" ${|} ${ExitDo} ${|}
        IntOp $R4 $R4 + 1
      ${Loop}
      IntOp $R3 $R4 - 1
      ${If} $R3 > 0
        StrCpy $R3 $R2 $R3 1
      ${Else}
        StrCpy $R3 ""
      ${EndIf}
      StrCpy $R2 $R2 "" $R4
      System::Call 'shlwapi::StrChrW(w R3, i 126) p .R1'
      ${If} $R1 <> 0
        ; the name in the folder that holds it, through the extended-length path; FindFirst gives its long name
        StrCpy $R1 $R5 2
        ${If} $R1 == "\\"
          StrCpy $R1 $R5 "" 2
          StrCpy $R1 "\\?\UNC\$R1\$R3"
        ${Else}
          StrCpy $R1 "\\?\$R5\$R3"
        ${EndIf}
        ; (not when it may have been cut to the longest NSIS string)
        StrCpy $R6 ""
        StrLen $R4 $R1
        IntOp $R4 $R4 + 1
        ${If} $R4 < ${NSIS_MAX_STRLEN}
          ClearErrors
          FindFirst $R4 $R6 $R1
          ${If} ${Errors}
            StrCpy $R6 ""
          ${Else}
            FindClose $R4
          ${EndIf}
          ${If} $R6 == ""
            ; the folder itself (not what a link there points to: FILE_FLAG_OPEN_REPARSE_POINT), for FILE_READ_ATTRIBUTES
            ; with FILE_FLAG_BACKUP_SEMANTICS (a folder), and the last name of its normalized path
            System::Call 'kernel32::CreateFileW(w R1, i 0x80, i 7, p 0, i 3, i 0x02200000, p 0) p .R4'
            ${If} $R4 <> -1
            ${AndIf} $R4 <> 0
              System::Call 'kernel32::GetFinalPathNameByHandleW(p R4, w .R6, i ${NSIS_MAX_STRLEN}, i 0) i .R1'
              System::Call 'kernel32::CloseHandle(p R4)'
              ${If} $R1 > 0
              ${AndIf} $R1 < ${NSIS_MAX_STRLEN}
                StrLen $R1 $R6
                ${Do}
                  IntOp $R1 $R1 - 1
                  ${IfThen} $R1 < 0 ${|} ${ExitDo} ${|}
                  StrCpy $R4 $R6 1 $R1
                  ${IfThen} $R4 == "\" ${|} ${ExitDo} ${|}
                ${Loop}
                IntOp $R1 $R1 + 1
                StrCpy $R6 $R6 "" $R1
              ${Else}
                StrCpy $R6 ""
              ${EndIf}
            ${EndIf}
          ${EndIf}
        ${EndIf}
        ; a name that cannot be made long: the path cannot be compared
        ${If} $R6 == ""
          StrCpy $R5 ""
          ${ExitDo}
        ${EndIf}
        StrCpy $R3 $R6
      ${EndIf}
      StrCpy $R5 "$R5\$R3"
    ${Loop}
    ; "" too when the long names would not fit in an NSIS string
    StrLen $R1 $R5
    IntOp $R1 $R1 + 1
    ${If} $R1 < ${NSIS_MAX_STRLEN}
      StrCpy $R0 $R5
    ${Else}
      StrCpy $R0 ""
    ${EndIf}
    mcs_long_done:
    Pop $R6
    Pop $R5
    Pop $R4
    Pop $R3
    Pop $R2
    Pop $R1
    Exch $R0
  FunctionEnd

  ; Stack in: a recorded path of an existing folder (callers skip missing folders first: McsIsDir). Stack out: the
  ; normalised absolute path without a trailing "\" (8.3 short names made long: McsLongNames; also more than MAX_PATH
  ; below the drive), or "" when it must not be touched (empty, relative, a drive or share root, or a shell folder such
  ; as the profile or Music), when a local folder is not there (McsIsDir), or when its 8.3 names cannot be made long
  ; (then McsCleanUnsure is 1). A network path is not looked up here but for its 8.3 names (the callers did: a server
  ; that does not answer is not waited for twice).
  Function ${UN}McsCleanPath
    Exch $R0
    Push $R1
    Push $R2
    Push $R3
    StrCpy $McsCleanUnsure 0
    StrCpy $R1 $R0 2 1
    StrCpy $R2 $R0 2
    ${If} $R1 != ":\"
    ${AndIf} $R1 != ":/"
    ${AndIf} $R2 != "\\"
    ${AndIf} $R2 != "//"
      StrCpy $R0 ""
      Goto mcs_clean_done
    ${EndIf}
    Push $R0
    Call ${UN}McsFullPath
    Pop $R0
    ${If} $R0 == ""
      Goto mcs_clean_done
    ${EndIf}
    StrCpy $R2 $R0 2
    ${If} $R2 != "\\"
      Push $R0
      Call ${UN}McsIsDir
      Pop $R1
      ${If} $R1 <> 1
        StrCpy $R0 ""
        Goto mcs_clean_done
      ${EndIf}
    ${EndIf}
    Push $R0
    Call ${UN}McsLongNames
    Pop $R0
    ${If} $R0 == ""
      StrCpy $McsCleanUnsure 1
      Goto mcs_clean_done
    ${EndIf}
    mcs_clean_strip:
      StrCpy $R1 $R0 1 -1
      ${If} $R1 == "\"
        StrCpy $R0 $R0 -1
        Goto mcs_clean_strip
      ${EndIf}
    StrLen $R1 $R0
    ${If} $R1 <= 3
      StrCpy $R0 ""
      Goto mcs_clean_done
    ${EndIf}
    ; A UNC path needs a folder below the share (\\server\share\folder: at least four backslashes).
    StrCpy $R2 $R0 2
    ${If} $R2 == "\\"
      StrCpy $R2 0
      StrCpy $R3 0
      ${Do}
        StrCpy $R1 $R0 1 $R3
        ${IfThen} $R1 == "" ${|} ${ExitDo} ${|}
        ${IfThen} $R1 == "\" ${|} IntOp $R2 $R2 + 1 ${|}
        IntOp $R3 $R3 + 1
      ${Loop}
      ${If} $R2 < 4
        StrCpy $R0 ""
        Goto mcs_clean_done
      ${EndIf}
    ${EndIf}
    Push $R0
    Call ${UN}McsIsShellPath
    Pop $R1
    ${If} $R1 = 1
      StrCpy $R0 ""
      Goto mcs_clean_done
    ${EndIf}
    ${If} $R0 == $PROFILE
    ${OrIf} $R0 == "$PROFILE\Downloads"
    ${OrIf} $R0 == $DOCUMENTS
    ${OrIf} $R0 == $MUSIC
    ${OrIf} $R0 == $DESKTOP
    ${OrIf} $R0 == $PICTURES
    ${OrIf} $R0 == $VIDEOS
    ${OrIf} $R0 == $APPDATA
    ${OrIf} $R0 == $LOCALAPPDATA
    ${OrIf} $R0 == $WINDIR
    ${OrIf} $R0 == $SYSDIR
    ${OrIf} $R0 == $PROGRAMFILES
    ${OrIf} $R0 == $PROGRAMFILES64
      StrCpy $R0 ""
    ${EndIf}
    mcs_clean_done:
    Pop $R3
    Pop $R2
    Pop $R1
    Exch $R0
  FunctionEnd

  ; Stack in: a string, then (on top) a set of characters. Stack out: 1 when the string is not empty and holds only
  ; characters of the set, compared exactly (StrSpnW: letter case counts, no locale rules), else 0.
  Function ${UN}McsOnly
    Exch $R0
    Exch
    Exch $R1
    Push $R2
    Push $R3
    StrLen $R2 $R1
    StrCpy $R3 -1
    System::Call 'shlwapi::StrSpnW(w R1, w R0) i .R3'
    ${If} $R2 > 0
    ${AndIf} $R3 = $R2
      StrCpy $R1 1
    ${Else}
      StrCpy $R1 0
    ${EndIf}
    Pop $R3
    Pop $R2
    Exch
    Pop $R0
    Exch $R1
  FunctionEnd

  ; Stack in: a file name. Stack out: 1 when it is a name ComfyUI's save nodes give the app's generation and
  ; separation outputs in comfy_output\mcs and mcs_sep, else 0: <id>_<counter>_.flac or .wav, the id 8 hex digits
  ; (followed by "_vocals" or "_instrumental" for a separation's stems), the counter 5 or more digits. The same rule
  ; as is_comfy_output_name in src-tauri/src/lib.rs (keep the two in step: both are checked with the names of
  ; tools/uninstall_name_cases.txt, here by tools/nsis_hooks_test.ps1, there by lib.rs the_uninstallers_name_rules_are_the_apps).
  Function ${UN}McsIsOutputName
    Exch $R0
    Push $R1
    Push $R2
    Push $R3
    StrCpy $R3 0
    StrCpy $R1 $R0 "" -6
    StrCpy $R2 $R0 "" -5
    ${If} $R1 S== "_.flac"
      StrCpy $R0 $R0 -6
    ${ElseIf} $R2 S== "_.wav"
      StrCpy $R0 $R0 -5
    ${Else}
      Goto mcs_output_name_done
    ${EndIf}
    ; The counter after the last "_", the id before it.
    StrLen $R1 $R0
    ${Do}
      IntOp $R1 $R1 - 1
      ${If} $R1 < 0
        Goto mcs_output_name_done
      ${EndIf}
      StrCpy $R2 $R0 1 $R1
      ${If} $R2 S== "_"
        ${ExitDo}
      ${EndIf}
    ${Loop}
    IntOp $R2 $R1 + 1
    StrCpy $R2 $R0 "" $R2
    StrCpy $R0 $R0 $R1
    StrLen $R1 $R2
    ${If} $R1 < 5
      Goto mcs_output_name_done
    ${EndIf}
    Push $R2
    Push "0123456789"
    Call ${UN}McsOnly
    Pop $R1
    ${If} $R1 <> 1
      Goto mcs_output_name_done
    ${EndIf}
    StrCpy $R1 $R0 "" -7
    StrCpy $R2 $R0 "" -13
    ${If} $R1 S== "_vocals"
      StrCpy $R0 $R0 -7
    ${ElseIf} $R2 S== "_instrumental"
      StrCpy $R0 $R0 -13
    ${EndIf}
    StrLen $R1 $R0
    ${If} $R1 = 8
      Push $R0
      Push "0123456789abcdefABCDEF"
      Call ${UN}McsOnly
      Pop $R3
    ${EndIf}
    mcs_output_name_done:
    StrCpy $R0 $R3
    Pop $R3
    Pop $R2
    Pop $R1
    Exch $R0
  FunctionEnd

  ; Stack in: a file name. Stack out: 1 when it is a name the app's staged copies have in comfy_input\mcs_uploads,
  ; else 0: <hash>_<stem>, optionally followed by "." and an extension, the hash 16 lowercase hex digits, the stem 1
  ; to 40 of A-Z a-z 0-9 _ -, the extension 1 to 8 of a-z 0-9 _ -; or such a name followed by ".<32 lowercase hex
  ; digits>.part" (a copy cut off). The same rule as is_staged_upload_name in src-tauri/src/comfy/client.rs (keep the
  ; two in step: both are checked with the names of tools/uninstall_name_cases.txt).
  Function ${UN}McsIsStagedName
    Exch $R0
    Push $R1
    Push $R2
    Push $R3
    Push $R4
    StrCpy $R4 0
    ; "<copy>.<id>.part": the id after the last "." before ".part" (a name ending in ".part" without another "." is
    ; a copy of a file named *.part).
    StrCpy $R1 $R0 "" -5
    ${If} $R1 S== ".part"
      StrCpy $R1 $R0 -5
      StrLen $R2 $R1
      ${Do}
        IntOp $R2 $R2 - 1
        ${If} $R2 < 0
          ${ExitDo}
        ${EndIf}
        StrCpy $R3 $R1 1 $R2
        ${If} $R3 S== "."
          ${ExitDo}
        ${EndIf}
      ${Loop}
      ${If} $R2 >= 0
        IntOp $R3 $R2 + 1
        StrCpy $R3 $R1 "" $R3
        StrCpy $R0 $R1 $R2
        StrLen $R2 $R3
        ${If} $R2 <> 32
          Goto mcs_staged_name_done
        ${EndIf}
        Push $R3
        Push "0123456789abcdef"
        Call ${UN}McsOnly
        Pop $R2
        ${If} $R2 <> 1
          Goto mcs_staged_name_done
        ${EndIf}
      ${EndIf}
    ${EndIf}
    ; The hash and the "_" after it.
    StrCpy $R1 $R0 1 16
    ${If} $R1 S!= "_"
      Goto mcs_staged_name_done
    ${EndIf}
    StrCpy $R1 $R0 16
    Push $R1
    Push "0123456789abcdef"
    Call ${UN}McsOnly
    Pop $R2
    ${If} $R2 <> 1
      Goto mcs_staged_name_done
    ${EndIf}
    StrCpy $R0 $R0 "" 17
    ; The stem before the first ".", the extension after it.
    StrLen $R3 $R0
    StrCpy $R2 0
    ${Do}
      ${If} $R2 >= $R3
        StrCpy $R2 -1
        ${ExitDo}
      ${EndIf}
      StrCpy $R1 $R0 1 $R2
      ${If} $R1 S== "."
        ${ExitDo}
      ${EndIf}
      IntOp $R2 $R2 + 1
    ${Loop}
    ${If} $R2 >= 0
      IntOp $R1 $R2 + 1
      StrCpy $R3 $R0 "" $R1
      StrCpy $R0 $R0 $R2
      StrLen $R1 $R3
      ${If} $R1 > 8
        Goto mcs_staged_name_done
      ${EndIf}
      Push $R3
      Push "abcdefghijklmnopqrstuvwxyz0123456789_-"
      Call ${UN}McsOnly
      Pop $R1
      ${If} $R1 <> 1
        Goto mcs_staged_name_done
      ${EndIf}
    ${EndIf}
    StrLen $R1 $R0
    ${If} $R1 <= 40
      Push $R0
      Push "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-"
      Call ${UN}McsOnly
      Pop $R4
    ${EndIf}
    mcs_staged_name_done:
    StrCpy $R0 $R4
    Pop $R4
    Pop $R3
    Pop $R2
    Pop $R1
    Exch $R0
  FunctionEnd

  ; Stack in: a folder, then (on top) "staged" or "output". Deletes the files at the top of the folder named as the
  ; app names its files there: "staged" the copies in comfy_input\mcs_uploads (McsIsStagedName), "output" ComfyUI's
  ; outputs in comfy_output\mcs and mcs_sep (McsIsOutputName). Sub-folders and other files are never touched: these
  ; folders may have been the song folder once, holding song folders, exports and diagnostic bundles.
  ; Listed and deleted through the extended-length path (as McsRMDirR): a staged copy's name is up to 104
  ; characters, more than MAX_PATH below a data root of about 130 characters, where the app writes with long paths.
  Function ${UN}McsDeleteOwnFiles
    Exch $R1
    Exch
    Exch $R0
    Push $R2
    Push $R3
    Push $R4
    StrCpy $R4 $R0 2
    ${If} $R4 == "\\"
      StrCpy $R4 $R0 "" 2
      StrCpy $R0 "\\?\UNC\$R4"
    ${Else}
      StrCpy $R0 "\\?\$R0"
    ${EndIf}
    ClearErrors
    FindFirst $R2 $R3 "$R0\*"
    ${DoUntil} ${Errors}
      ${If} $R3 == ""
        ${ExitDo}
      ${EndIf}
      Push $R3
      ${If} $R1 == "staged"
        Call ${UN}McsIsStagedName
      ${Else}
        Call ${UN}McsIsOutputName
      ${EndIf}
      Pop $R4
      ${If} $R4 = 1
        ; Files only: Delete skips a folder (or a link to one) of that name.
        Delete "$R0\$R3"
      ${EndIf}
      ClearErrors
      FindNext $R2 $R3
    ${Loop}
    FindClose $R2
    ; The folder itself when it is left empty (RemoveDirectoryW is never recursive), also below a data root too long
    ; for a plain path, also on a share (NSIS's RMDir does nothing with a \\?\UNC\ path).
    System::Call 'kernel32::RemoveDirectoryW(w R0) i .R4'
    Pop $R4
    Pop $R3
    Pop $R2
    Pop $R0
    Pop $R1
  FunctionEnd

  ; Stack in: a cleaned song folder, then (on top) a cleaned data root. Stack out: 1 when the song folder is one
  ; of the folders McsDeleteDataRoot removes as a whole or deletes the app's files in (McsDeleteOwnFiles), or lies
  ; inside one, else 0. Keep the lists in step (checked by the config.rs test
  ; uninstaller_knows_every_folder_it_removes_with_the_tools). The tools prompt never deletes in the song folder: a
  ; song folder there (e.g. ComfyUI's own output folder in the runtime) would go with the tools, without its own
  ; prompt.
  Function ${UN}McsOutputInDataRoot
    Exch $R0
    Exch
    Exch $R1
    Push $R2
    Push $R3
    StrCpy $R2 0
    !insertmacro McsIfInside "runtime\ComfyUI_windows_portable"
    !insertmacro McsIfInside "runtime\bin"
    !insertmacro McsIfInside "runtime\ffmpeg"
    !insertmacro McsIfInside "runtime\llama"
    !insertmacro McsIfInside "runtime\.mcs_extracting"
    !insertmacro McsIfInside "cache\sep_work"
    !insertmacro McsIfInside "cache\align_stems"
    !insertmacro McsIfInside "comfy_input\mcs_uploads"
    !insertmacro McsIfInside "comfy_output\mcs"
    !insertmacro McsIfInside "comfy_output\mcs_sep"
    StrCpy $R1 $R2
    Pop $R3
    Pop $R2
    Exch
    Pop $R0
    Exch $R1
  FunctionEnd

  ; Stack in: a cleaned folder, then (on top) a cleaned data root. Stack out: 1 when the folder is one of the trees
  ; McsDeleteDataRoot removes as a whole (McsRMDirR) or lies inside one, else 0. Keep the list in step (checked by
  ; the config.rs test uninstaller_knows_every_folder_it_removes_with_the_tools).
  Function ${UN}McsInRemovedTree
    Exch $R0
    Exch
    Exch $R1
    Push $R2
    Push $R3
    StrCpy $R2 0
    !insertmacro McsIfInside "runtime\ComfyUI_windows_portable"
    !insertmacro McsIfInside "runtime\bin"
    !insertmacro McsIfInside "runtime\ffmpeg"
    !insertmacro McsIfInside "runtime\llama"
    !insertmacro McsIfInside "runtime\.mcs_extracting"
    !insertmacro McsIfInside "cache\sep_work"
    !insertmacro McsIfInside "cache\align_stems"
    StrCpy $R1 $R2
    Pop $R3
    Pop $R2
    Exch
    Pop $R0
    Exch $R1
  FunctionEnd

  ; Stack in: a full path of a folder. Stack out: 1 when it holds anything but ComfyUI's own placeholder of its output
  ; folder (_output_images_will_be_put_here), else 0. Listed through the extended-length path (without a trailing "\"
  ; before "\*": a path as recorded may end with one).
  Function ${UN}McsHasEntries
    Exch $R0
    Push $R1
    Push $R2
    Push $R3
    Push $R4
    mcs_entries_strip:
      StrCpy $R1 $R0 1 -1
      ${If} $R1 == "\"
        StrCpy $R0 $R0 -1
        Goto mcs_entries_strip
      ${EndIf}
    StrCpy $R1 $R0 2
    ${If} $R1 == "\\"
      StrCpy $R1 $R0 "" 2
      StrCpy $R1 "\\?\UNC\$R1"
    ${Else}
      StrCpy $R1 "\\?\$R0"
    ${EndIf}
    StrCpy $R3 0
    ClearErrors
    FindFirst $R2 $R4 "$R1\*"
    ${DoUntil} ${Errors}
      ${If} $R4 == ""
        ${ExitDo}
      ${EndIf}
      ${If} $R4 != "."
      ${AndIf} $R4 != ".."
      ${AndIf} $R4 != "_output_images_will_be_put_here"
        StrCpy $R3 1
        ${ExitDo}
      ${EndIf}
      ClearErrors
      FindNext $R2 $R4
    ${Loop}
    FindClose $R2
    StrCpy $R0 $R3
    Pop $R4
    Pop $R3
    Pop $R2
    Pop $R1
    Exch $R0
  FunctionEnd

  ; Stack in: the song folders used before the current one, "|"-separated (the app's FormerOutputDirs, config.rs
  ; former_output_dirs), then (on top) a cleaned data root. Stack out: the first of them that still exists, lies in
  ; a tree McsDeleteDataRoot removes as a whole (McsInRemovedTree; the app's files alone go in mcs_uploads, mcs and
  ; mcs_sep) or may lie in one (its 8.3 names cannot be made long: McsCleanUnsure), and still holds something
  ; (McsHasEntries: songs made there stay in the library, exports may be there), cleaned (the full path as recorded
  ; when it cannot be), or "" when none does; then (on top) 1 when that folder cannot be compared, else 0. The tools
  ; prompt must not take them along; a folder emptied since does not block it.
  Function ${UN}McsFormerInDataRoot
    Exch $R0
    Exch
    Exch $R1
    Push $R2
    Push $R3
    Push $R4
    Push $R5
    Push $R6
    StrCpy $R5 ""
    ${DoWhile} $R1 != ""
      ; $R4: the entry before the first "|", $R1: the rest
      StrCpy $R2 0
      StrLen $R3 $R1
      ${Do}
        ${If} $R2 >= $R3
          ${ExitDo}
        ${EndIf}
        StrCpy $R4 $R1 1 $R2
        ${If} $R4 == "|"
          ${ExitDo}
        ${EndIf}
        IntOp $R2 $R2 + 1
      ${Loop}
      StrCpy $R4 $R1 $R2
      IntOp $R2 $R2 + 1
      StrCpy $R1 $R1 "" $R2
      StrCpy $R3 0
      ${If} $R4 != ""
        Push $R4
        Call ${UN}McsIsDir
        Pop $R3
      ${EndIf}
      ${If} $R3 = 1
        StrCpy $R6 $R4
        Push $R4
        Call ${UN}McsCleanPath
        Pop $R4
        ; $R2: whether it cannot be compared (from this cleaning)
        StrCpy $R2 $McsCleanUnsure
        ${If} $R4 != ""
          Push $R4
          Push $R0
          Call ${UN}McsInRemovedTree
          Pop $R3
        ${ElseIf} $R2 = 1
          ; it may lie in such a tree: named by its full path as recorded, without a trailing "\"
          Push $R6
          Call ${UN}McsFullPath
          Pop $R4
          mcs_former_strip:
            StrCpy $R3 $R4 1 -1
            ${If} $R3 == "\"
              StrCpy $R4 $R4 -1
              Goto mcs_former_strip
            ${EndIf}
          StrCpy $R3 1
        ${Else}
          StrCpy $R3 0
        ${EndIf}
        ${If} $R3 = 1
          Push $R4
          Call ${UN}McsHasEntries
          Pop $R3
          ${If} $R3 = 1
            StrCpy $R5 $R4
            ${ExitDo}
          ${EndIf}
        ${EndIf}
      ${EndIf}
    ${Loop}
    ${If} $R5 == ""
      StrCpy $R2 0
    ${EndIf}
    StrCpy $R1 $R5
    StrCpy $R0 $R2
    Pop $R6
    Pop $R5
    Pop $R4
    Pop $R3
    Pop $R2
    ; out: the folder, then (on top) whether it cannot be compared; $R1 and $R0 as they were
    Exch $R1
    Exch
    Exch $R0
  FunctionEnd

  ; The uninstall hook's choice about the tools and models, on its registers. In: $0 the recorded data root, $1 the
  ; recorded song folder, $5 the song folders used before it ("|"-separated). Out: $7 and $8 1 when the song folder
  ; and the data root are there (McsIsDir), $3 the cleaned song folder ("" when it is not there or must not be
  ; touched), $2 the cleaned data root, $6 the folder the choice names, and $4 the choice:
  ;   none     the data root is not there: nothing is asked
  ;   root     the data root must not be touched (McsCleanPath gave "": a drive root, a shell folder, or a path whose
  ;            8.3 names cannot be made long)
  ;   inside   the song folder lies in the data root's folders the tools prompt deletes in (McsOutputInDataRoot)
  ;   unknown  the song folder cannot be compared with them (its 8.3 names cannot be made long): it may lie in them
  ;   former   a song folder used before lies in them and holds something (McsFormerInDataRoot)
  ;   former?  a song folder used before that cannot be compared holds something
  ;   ask      the tools prompt may be shown
  ; The song folder is cleaned first (the tools prompt must not remove it along with the tools), and each recorded
  ; path once: what that cleaning gave decides (McsCleanUnsure).
  Function ${UN}McsToolsChoice
    Push $R0
    StrCpy $7 0
    ${If} $1 != ""
      Push $1
      Call ${UN}McsIsDir
      Pop $7
    ${EndIf}
    StrCpy $8 0
    ${If} $0 != ""
      Push $0
      Call ${UN}McsIsDir
      Pop $8
    ${EndIf}
    StrCpy $2 ""
    StrCpy $3 ""
    StrCpy $4 "none"
    StrCpy $6 ""
    ; $R0: whether the song folder cannot be compared
    StrCpy $R0 0
    ${If} $7 = 1
      Push $1
      Call ${UN}McsCleanPath
      Pop $3
      StrCpy $R0 $McsCleanUnsure
    ${EndIf}
    ${If} $8 = 1
      Push $0
      Call ${UN}McsCleanPath
      Pop $2
      ${If} $2 == ""
        StrCpy $4 "root"
      ${ElseIf} $R0 = 1
        StrCpy $4 "unknown"
        StrCpy $6 $1
      ${Else}
        StrCpy $4 "ask"
        ${If} $3 != ""
          Push $3
          Push $2
          Call ${UN}McsOutputInDataRoot
          Pop $R0
          ${If} $R0 = 1
            StrCpy $4 "inside"
            StrCpy $6 $3
          ${EndIf}
        ${EndIf}
        ${If} $4 == "ask"
        ${AndIf} $5 != ""
          Push $5
          Push $2
          Call ${UN}McsFormerInDataRoot
          Pop $R0
          Pop $6
          ${If} $6 != ""
            ${If} $R0 = 1
              StrCpy $4 "former?"
            ${Else}
              StrCpy $4 "former"
            ${EndIf}
          ${EndIf}
        ${EndIf}
      ${EndIf}
    ${EndIf}
    Pop $R0
  FunctionEnd

  ; Stack in: a cleaned data root. Removes what setup / the app create there (the runtime's parts, the app's
  ; caches and download archives, the app's files in ComfyUI's input / output folders of this app, the downloaded
  ; models and the app's model caches), then empty folders and the root itself when nothing else is left. Other
  ; files, e.g. another tool's cache\ or runtime\ entries, the user's own models or an output folder inside the data
  ; root, are kept (a song folder inside one of the folders deleted in is checked first: McsOutputInDataRoot).
  ; comfy_input\mcs_uploads, comfy_output\mcs and mcs_sep may have been the song folder once, so only the app's
  ; names at their top go there (McsDeleteOwnFiles, the same names the app's own prune deletes), never a song
  ; folder, an export or a diagnostic bundle saved there.
  ; A junction or symbolic link at a folder the deletes go through (runtime, cache, models\checkpoints ...; McsRMDirR
  ; only checks the folder it is given, Delete none), or at a folder McsDeleteOwnFiles deletes in (it lists what is
  ; behind a link), would take them into its target, e.g. a models folder shared with another tool or a link another
  ; account put in an unprotected data root: such a link is removed first (the link only), and nothing is deleted
  ; while one stays. Keep the McsUnlink list in step with the deletes below (checked by the config.rs test
  ; uninstaller_unlinks_every_folder_it_deletes_through).
  Function ${UN}McsDeleteDataRoot
    Exch $R0
    Push $R1
    Push $R2
    StrCpy $R2 0
    !insertmacro McsUnlink "${UN}" "$R0\runtime"
    !insertmacro McsUnlink "${UN}" "$R0\cache"
    !insertmacro McsUnlink "${UN}" "$R0\comfy_input"
    !insertmacro McsUnlink "${UN}" "$R0\comfy_input\mcs_uploads"
    !insertmacro McsUnlink "${UN}" "$R0\comfy_output"
    !insertmacro McsUnlink "${UN}" "$R0\comfy_output\mcs"
    !insertmacro McsUnlink "${UN}" "$R0\comfy_output\mcs_sep"
    !insertmacro McsUnlink "${UN}" "$R0\models"
    !insertmacro McsUnlink "${UN}" "$R0\models\checkpoints"
    !insertmacro McsUnlink "${UN}" "$R0\models\audio_encoders"
    !insertmacro McsUnlink "${UN}" "$R0\models\llm"
    !insertmacro McsUnlink "${UN}" "$R0\models\torch"
    !insertmacro McsUnlink "${UN}" "$R0\models\torch\hub"
    !insertmacro McsUnlink "${UN}" "$R0\models\torch\hub\checkpoints"
    !insertmacro McsUnlink "${UN}" "$R0\models\separation"
    ${If} $R2 <> 0
      Goto mcs_delete_data_done
    ${EndIf}
    !insertmacro McsRMDirR "${UN}" "$R0\runtime\ComfyUI_windows_portable"
    !insertmacro McsRMDirR "${UN}" "$R0\runtime\bin"
    !insertmacro McsRMDirR "${UN}" "$R0\runtime\ffmpeg"
    !insertmacro McsRMDirR "${UN}" "$R0\runtime\llama"
    !insertmacro McsRMDirR "${UN}" "$R0\runtime\.mcs_extracting"
    RMDir "$R0\runtime"
    !insertmacro McsRMDirR "${UN}" "$R0\cache\sep_work"
    !insertmacro McsRMDirR "${UN}" "$R0\cache\align_stems"
    Delete "$R0\cache\pip-constraints-*.txt"
    ; Download archives kept for a resumed setup (setup.rs components; "*" also takes the .part). Checked by the
    ; config.rs test uninstaller_deletes_every_download_archive.
    Delete "$R0\cache\ComfyUI_windows_portable_nvidia.7z*"
    Delete "$R0\cache\ffmpeg-*-win64-gpl-*.zip*"
    Delete "$R0\cache\llama-b*-bin-win-*-x64.zip*"
    Delete "$R0\cache\cudart-llama-bin-win-*-x64.zip*"
    RMDir "$R0\cache"
    !insertmacro McsDeleteOwnFiles "${UN}" "$R0\comfy_input\mcs_uploads" "staged"
    RMDir "$R0\comfy_input\mcs_uploads"
    RMDir "$R0\comfy_input\3d"
    RMDir "$R0\comfy_input"
    !insertmacro McsDeleteOwnFiles "${UN}" "$R0\comfy_output\mcs" "output"
    !insertmacro McsDeleteOwnFiles "${UN}" "$R0\comfy_output\mcs_sep" "output"
    RMDir "$R0\comfy_output\mcs"
    RMDir "$R0\comfy_output\mcs_sep"
    RMDir "$R0\comfy_output"
    Delete "$R0\extra_model_paths.yaml"
    ; Downloaded models (setup.rs components; "*" also takes an interrupted download's .part).
    Delete "$R0\models\checkpoints\yue2_3b_bf16.safetensors*"
    Delete "$R0\models\checkpoints\yue2_3b_int8_convrot.safetensors*"
    Delete "$R0\models\audio_encoders\sheetsage2_bf16.safetensors*"
    Delete "$R0\models\llm\Qwen3-14B-Q4_K_M.gguf*"
    Delete "$R0\models\torch\hub\checkpoints\model.pt*"
    ; Separation models and the data files audio-separator 0.47 fetches on first use (MCS_SEPARATION_MODELS_DIR):
    ; one line per SEPARATION_MODELS name in comfy-nodes/mcs_yue2_nodes/nodes.py plus the files downloaded with
    ; it (the roformer configs, the four htdemucs_ft checkpoints). Every pattern ends in "*" or ".*": the node pack
    ; downloads into <file>.mcs_part, which a ComfyUI killed mid-download leaves behind. Checked by the config.rs
    ; test uninstaller_deletes_every_separation_model.
    Delete "$R0\models\separation\model_bs_roformer_*"
    Delete "$R0\models\separation\vocals_mel_band_roformer.*"
    Delete "$R0\models\separation\melband_roformer_big_beta4.*"
    Delete "$R0\models\separation\config_melbandroformer_big_beta4.yaml*"
    Delete "$R0\models\separation\htdemucs_ft.yaml*"
    Delete "$R0\models\separation\f7e0c4bc-ba3fe64a.th*"
    Delete "$R0\models\separation\d12395a8-e57c48e6.th*"
    Delete "$R0\models\separation\92cfc3b6-ef3bcb9c.th*"
    Delete "$R0\models\separation\04573f0d-f3cf25b2.th*"
    Delete "$R0\models\separation\download_checks.json*"
    Delete "$R0\models\separation\mdx_model_data.json*"
    Delete "$R0\models\separation\vr_model_data.json*"
    RMDir "$R0\models\torch\hub\checkpoints"
    RMDir "$R0\models\torch\hub"
    RMDir "$R0\models\torch"
    RMDir "$R0\models\separation"
    RMDir "$R0\models\checkpoints"
    RMDir "$R0\models\audio_encoders"
    RMDir "$R0\models\loras"
    RMDir "$R0\models\llm"
    RMDir "$R0\models"
    RMDir "$R0"
    mcs_delete_data_done:
    Pop $R2
    Pop $R1
    Pop $R0
  FunctionEnd

  ; Stack in: a cleaned song folder. Removes the song folders the app created (<YYYY-MM-DD>\<HHMMSS>_<8 chars of
  ; the id>, as jobs.rs names them, holding song.json / workflow_api.json / failure.json), the separations of
  ; files outside the library (separated\<YYYYMMDD>_<HHMMSS>_<name>) and diagnostic bundles, then empty date
  ; folders, separated\ and the folder itself. Exports and other files are kept.
  Function ${UN}McsDeleteOutput
    Exch $R0
    Push $R1
    Push $R2
    Push $R3
    Push $R4
    Push $R5
    ClearErrors
    FindFirst $R1 $R2 "$R0\????-??-??"
    ${DoUntil} ${Errors}
      ${If} $R2 == ""
        ${ExitDo}
      ${EndIf}
      StrLen $R5 $R2
      ${If} $R5 = 10
      ${AndIf} ${FileExists} "$R0\$R2\*.*"
        ClearErrors
        FindFirst $R3 $R4 "$R0\$R2\??????_????????"
        ${DoUntil} ${Errors}
          ${If} $R4 == ""
            ${ExitDo}
          ${EndIf}
          ; "?" may match nothing at the end of a pattern: check the length and the "_" too.
          StrLen $R5 $R4
          ${If} $R5 = 15
            StrCpy $R5 $R4 1 6
            ${If} $R5 == "_"
              ${If} ${FileExists} "$R0\$R2\$R4\song.json"
              ${OrIf} ${FileExists} "$R0\$R2\$R4\workflow_api.json"
              ${OrIf} ${FileExists} "$R0\$R2\$R4\failure.json"
                !insertmacro McsRMDirR "${UN}" "$R0\$R2\$R4"
              ${EndIf}
            ${EndIf}
          ${EndIf}
          ClearErrors
          FindNext $R3 $R4
        ${Loop}
        FindClose $R3
        RMDir "$R0\$R2"
      ${EndIf}
      ClearErrors
      FindNext $R1 $R2
    ${Loop}
    FindClose $R1
    ClearErrors
    FindFirst $R1 $R2 "$R0\separated\????????_??????_*"
    ${DoUntil} ${Errors}
      ${If} $R2 == ""
        ${ExitDo}
      ${EndIf}
      StrLen $R5 $R2
      StrCpy $R3 $R2 1 8
      StrCpy $R4 $R2 1 15
      ${If} $R5 > 16
      ${AndIf} $R3 == "_"
      ${AndIf} $R4 == "_"
      ${AndIf} ${FileExists} "$R0\separated\$R2\*.*"
        !insertmacro McsRMDirR "${UN}" "$R0\separated\$R2"
      ${EndIf}
      ClearErrors
      FindNext $R1 $R2
    ${Loop}
    FindClose $R1
    RMDir "$R0\separated"
    Delete "$R0\mcs-diagnostics-*.zip"
    Delete "$R0\mcs-diagnostics-*.zip.part"
    RMDir "$R0"
    Pop $R5
    Pop $R4
    Pop $R3
    Pop $R2
    Pop $R1
    Pop $R0
  FunctionEnd
!macroend

!insertmacro McsHookFunctions "un."

!macro NSIS_HOOK_POSTUNINSTALL
  ; Nothing is removed by an updater-driven uninstall.
  ${If} $UpdateMode <> 1
    SetShellVarContext current
    ; Read before the key may be deleted below.
    ReadRegStr $0 HKCU "Software\MusicCreatorStudioYuE2" "DataRoot"
    ReadRegStr $1 HKCU "Software\MusicCreatorStudioYuE2" "OutputDir"
    ; The song folders used before the current one (config.rs former_output_dirs): their songs stay in the library.
    ReadRegStr $5 HKCU "Software\MusicCreatorStudioYuE2" "FormerOutputDirs"
    ; Passive (/P) and silent (/S) uninstalls keep both folders; the prompts default to No. A recorded folder
    ; that no longer exists (already deleted, or on a disconnected drive) is skipped without a message.
    ${If} $PassiveMode <> 1
      ; What to do about the tools and models (McsToolsChoice, checked case by case by tools/nsis_hooks_test.ps1; it
      ; also sets $7 / $8 whether the song folder / data root are there, and $3 / $2 those folders cleaned).
      Call un.McsToolsChoice
      ${If} $4 == "root"
        MessageBox MB_OK|MB_ICONINFORMATION "ツールとモデルのフォルダ（$0）は、ドライブ直下・相対パス・ユーザーの共通フォルダのいずれかか、8.3 形式の短い名前を確かめられないため、自動では削除しません。不要なファイルは手動で削除してください。" /SD IDOK
      ${ElseIf} $4 == "inside"
        MessageBox MB_OK|MB_ICONINFORMATION "楽曲の保存先（$6）が、ツールとモデルのフォルダ（$2）のうちアプリが管理するフォルダの中にあるため、ツールとモデルは自動では削除しません（曲が消えないように）。曲を別の場所へ移してから、不要なファイルを手動で削除してください。" /SD IDOK
      ${ElseIf} $4 == "unknown"
        MessageBox MB_OK|MB_ICONINFORMATION "楽曲の保存先（$6）の 8.3 形式の短い名前を確かめられず、ツールとモデルのフォルダ（$2）の中にあるか分からないため、ツールとモデルは自動では削除しません（曲が消えないように）。曲を別の場所へ移してから、不要なファイルを手動で削除してください。" /SD IDOK
      ${ElseIf} $4 == "former"
        MessageBox MB_OK|MB_ICONINFORMATION "以前の楽曲の保存先（$6）が、ツールとモデルのフォルダ（$2）のうちアプリが管理するフォルダの中にあるため、ツールとモデルは自動では削除しません（そこに残っている曲が消えないように）。曲を別の場所へ移してから、不要なファイルを手動で削除してください。" /SD IDOK
      ${ElseIf} $4 == "former?"
        MessageBox MB_OK|MB_ICONINFORMATION "以前の楽曲の保存先（$6）の 8.3 形式の短い名前を確かめられず、ツールとモデルのフォルダ（$2）の中にあるか分からないため、ツールとモデルは自動では削除しません（そこに残っている曲が消えないように）。曲を別の場所へ移してから、不要なファイルを手動で削除してください。" /SD IDOK
      ${ElseIf} $4 == "ask"
        MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "ダウンロードしたツールとモデル（$2）を削除しますか？$\r$\n（ComfyUI、YuE2 モデル、ffmpeg、LLM など。数十 GB）$\r$\n$\r$\nこのアプリが作成したファイルのみを完全に削除します（ごみ箱には移動しません）。フォルダ内のほかのファイルは残します。$\r$\n$\r$\n新しい版へ更新するためのアンインストールなら「いいえ」を選んでください。" /SD IDNO IDNO mcs_skip_data
          Push $2
          Call un.McsDeleteDataRoot
        mcs_skip_data:
      ${EndIf}
      StrCpy $7 0
      ${If} $1 != ""
        Push $1
        Call un.McsIsDir
        Pop $7
      ${EndIf}
      ${If} $7 = 1
        ${If} $3 == ""
          MessageBox MB_OK|MB_ICONINFORMATION "楽曲の保存先（$1）は、ドライブ直下・相対パス・ユーザーの共通フォルダのいずれかか、8.3 形式の短い名前を確かめられないため、自動では削除しません。不要な曲フォルダは手動で削除してください。" /SD IDOK
        ${Else}
          MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "生成した楽曲（$3）も削除しますか？$\r$\n$\r$\nこのアプリが作成した曲フォルダ・分離結果・診断バンドルのみを完全に削除します（ごみ箱には移動しません）。書き出したファイルなど、フォルダ内のほかのファイルは残します。$\r$\n$\r$\n新しい版へ更新するためのアンインストールなら「いいえ」を選んでください。" /SD IDNO IDNO mcs_skip_output
            Push $3
            Call un.McsDeleteOutput
          mcs_skip_output:
        ${EndIf}
      ${EndIf}
    ${EndIf}
    ; Settings, the library database, API keys, logs and the WebView data: only with Tauri's
    ; "アプリケーションデータを削除する" checkbox on the confirm page (unticked by default, also in the
    ; uninstall step of an upgrade; 0 in passive / silent mode). The registry record stays otherwise, so a
    ; later real uninstall still knows the data root and the song folder.
    ${If} $DeleteAppDataCheckboxState = 1
      !insertmacro McsRMDirR "un." "$APPDATA\MusicCreatorStudioYuE2"
      !insertmacro McsRMDirR "un." "$LOCALAPPDATA\com.utausnskareshi.musiccreatorstudioyue2"
      DeleteRegKey HKCU "Software\MusicCreatorStudioYuE2"
    ${EndIf}
  ${EndIf}
!macroend
