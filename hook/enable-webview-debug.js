import Java from 'frida-java-bridge';

send({ type: 'agent-loaded', pid: Process.id, arch: Process.arch, javaAvailable: Java.available });

function enableWebViewDebugging() {
  if (!Java.available) {
    setTimeout(enableWebViewDebugging, 250);
    return;
  }

  Java.perform(() => {
    Java.scheduleOnMainThread(() => {
      try {
        const WebView = Java.use('android.webkit.WebView');
        WebView.setWebContentsDebuggingEnabled(true);
        send({ type: 'webview-debug-enabled', pid: Process.id, arch: Process.arch });
      } catch (error) {
        send({ type: 'webview-debug-error', message: String(error), stack: error.stack });
      }
    });
  });
}

// The x64 ART process is still settling when MuMu first exposes it. Delaying
// bridge class access avoids a transient JVMTI pointer fault during startup.
setTimeout(enableWebViewDebugging, 3000);
