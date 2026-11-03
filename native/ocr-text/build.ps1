# SPIKE: builds native/ocr-text/ocr-text.exe into build/ocr-spike with MSVC and the Windows
# SDK's C++/WinRT headers, with the same hardening flags as the shipped helpers.
$ErrorActionPreference = 'Stop'
$root = Resolve-Path "$PSScriptRoot/../.."
$out = Join-Path $root 'build/ocr-spike'
New-Item -ItemType Directory -Force $out | Out-Null
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
$vs = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
$vcvars = Join-Path $vs 'VC/Auxiliary/Build/vcvars64.bat'
$src = Join-Path $PSScriptRoot 'ocr-text.cpp'
$cmd = Join-Path $out 'build.cmd'
@"
@echo off
call "$vcvars" >nul || exit /b 1
cd /d "$out" || exit /b 1
echo MSVC %VCToolsVersion% SDK %WindowsSDKVersion%
cl /nologo /c /std:c++17 /permissive- /EHsc /bigobj /O1 /MT /GS /guard:cf /W4 /Brepro /Foocr-text.obj "$src" || exit /b 1
link /nologo /Brepro /DYNAMICBASE /HIGHENTROPYVA /NXCOMPAT /guard:cf /CETCOMPAT /DEPENDENTLOADFLAG:0x800 /SUBSYSTEM:CONSOLE /OUT:ocr-text.exe ocr-text.obj kernel32.lib advapi32.lib ole32.lib windowscodecs.lib windowsapp.lib || exit /b 1
"@ | Set-Content -Encoding ascii $cmd
cmd.exe /d /c $cmd
if ($LASTEXITCODE -ne 0) { throw "build failed ($LASTEXITCODE)" }
$exe = Get-Item (Join-Path $out 'ocr-text.exe')
$hash = (Get-FileHash $exe -Algorithm SHA256).Hash.ToLower()
"Built $($exe.FullName) ($($exe.Length) bytes, sha256 $hash)"
if ($env:GITHUB_ENV) { "OCR_TEXT_SIZE=$($exe.Length)" | Out-File -Append -Encoding utf8 $env:GITHUB_ENV }
