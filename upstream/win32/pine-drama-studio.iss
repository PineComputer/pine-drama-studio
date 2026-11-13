; Pine Drama Studio's Windows installer: Code-OSS's own Inno Setup script (build/win32/code.iss), with our publisher and
; links in place of Microsoft's. scripts/release-win32.mjs compiles it with the definitions upstream's gulp task gives
; code.iss (build/gulpfile.vscode.win32.ts, buildWin32Setup), plus CodeIss, the path of code.iss, and Publisher
; (release-win32.mjs PUBLISHER). The directives below
; come after code.iss's own; the install test (scripts/win32/verify-install.ps1) checks that the installed app's
; Publisher is ours, so an Inno Setup that kept the first value would fail it.
#include CodeIss

[Setup]
AppPublisher={#Publisher}
AppPublisherURL=https://github.com/PineComputer/pine-drama-studio
AppSupportURL=https://github.com/PineComputer/pine-drama-studio/issues
AppUpdatesURL=https://github.com/PineComputer/pine-drama-studio/releases
