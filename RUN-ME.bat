@echo off
cd /d E:\douyin-golden-goose-crawler
echo ═══ Signing APK ═══
java -jar tmp\uber-apk-signer.jar --apks tmp\douyin-mall-patched.apk --allowResign --ksAlias debug --ksPass android
if %ERRORLEVEL% NEQ 0 (
    echo Signature failed! Exiting.
    pause
    exit /b 1
)
echo ═══ Installing APK ═══
adb -s emulator-5554 uninstall com.ss.android.ugc.livelite
adb -s emulator-5554 install tmp\douyin-mall-patched.apk
adb -s emulator-5554 forward tcp:27042 tcp:27042

echo ═══ Launching app ═══
adb -s emulator-5554 shell am start -n com.ss.android.ugc.livelite/com.ss.android.ugc.aweme.main.MainActivity
echo.
echo ═══════════════════════════════════════════
echo  PLEASE LOGIN TO DOUYIN NOW (60 seconds)
echo ═══════════════════════════════════════════
timeout /t 60 /nobreak

echo ═══ Starting Full Auto Crawl ═══
set MUMU_SERIAL=emulator-5554
node auto-full-crawl.mjs
pause
