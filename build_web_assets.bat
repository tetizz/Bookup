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

copy /y shared\product-shell.css docs\product-shell.css >nul
copy /y shared\product-shell.js docs\product-shell.js >nul
copy /y shared\product-shell.css bookup\static\product-shell.css >nul
copy /y shared\product-shell.js bookup\static\product-shell.js >nul

copy /y docs\index.html docs\app.html >nul
echo Bookup Web assets are ready.
