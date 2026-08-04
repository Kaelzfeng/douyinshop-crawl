/**
 * Enumerate all captcha/face/identity/risk-related classes in Douyin Mall.
 * Run: frida -U -l hook/enumerate-verify-classes.js com.ss.android.ugc.livelite
 * Or via Node: node hook/run-enumerate.mjs
 */
import Java from 'frida-java-bridge';

const KEYWORDS = [
  'turing', 'captcha', 'verify', 'face', 'identity',
  'liveness', 'risk', 'security', 'challenge', 'antibot',
  'realname', 'real_name', 'auth', 'check', 'guard',
  'fingerprint', 'devicecheck', 'safetynet',
];

Java.perform(() => {
  const found = new Set();
  Java.enumerateLoadedClasses({
    onMatch: (className) => {
      const lower = className.toLowerCase();
      for (const kw of KEYWORDS) {
        if (lower.includes(kw)) {
          found.add(className);
          break;
        }
      }
    },
    onComplete: () => {
      const sorted = [...found].sort();
      console.log(`\n=== Found ${sorted.length} verification-related classes ===\n`);
      for (const cls of sorted) {
        console.log(cls);
      }
      console.log('\n=== Done ===');
    },
  });
});
