@echo off
setlocal
cd /d "%~dp0"

echo Building optimized Bookup Web assets...
call npx --yes esbuild docs\web-app.js --minify --target=es2020 --outfile=docs\web-app.min.js
if errorlevel 1 exit /b 1

call npx --yes esbuild docs\position-analysis.js --minify --target=es2020 --outfile=docs\position-analysis.min.js
if errorlevel 1 exit /b 1

call npx --yes esbuild docs\smart-theory-engine.js --minify --target=es2020 --outfile=docs\smart-theory-engine.min.js
if errorlevel 1 exit /b 1

call npx --yes esbuild docs\styles.css --minify --outfile=docs\styles.min.css
if errorlevel 1 exit /b 1

rem The web product shell is canonical. Sync outward so a build can never
rem overwrite a newer deployed shell with stale shared/desktop copies.
copy /y docs\product-shell.css shared\product-shell.css >nul
if errorlevel 1 exit /b 1
copy /y docs\product-shell.js shared\product-shell.js >nul
if errorlevel 1 exit /b 1
copy /y docs\product-shell.css bookup\static\product-shell.css >nul
if errorlevel 1 exit /b 1
copy /y docs\product-shell.js bookup\static\product-shell.js >nul
if errorlevel 1 exit /b 1

copy /y docs\index.html docs\app.html >nul
if errorlevel 1 exit /b 1
echo Bookup Web assets are ready.
