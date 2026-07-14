/**
 * Push mitmproxy CA cert to MuMu system trust store.
 * Requires root (MuMu has this by default).
 */
import { _android } from 'playwright';
import { readFileSync } from 'fs';

const CERT_HASH = 'c8750f0d';
const CERT_SRC = 'mitmproxy-ca.0';
const CERT_DST = `/system/etc/security/cacerts/${CERT_HASH}.0`;

const ds = await _android.devices({ host: '127.0.0.1', port: 5037 });
const d = ds.find(c => c.serial() === '127.0.0.1:16384');
if (!d) { console.log('MuMu not found'); process.exit(1); }

try {
  // Step 1: Remount /system as rw
  console.log('1. Remounting /system as rw...');
  await d.shell('mount -o rw,remount /system');
  console.log('   Done');

  // Step 2: Push cert file
  console.log('2. Pushing cert...');
  const certData = readFileSync(CERT_SRC);
  const b64 = certData.toString('base64');

  // Write via base64 - small file so single chunk is fine
  await d.shell(`echo ${JSON.stringify(b64)} | base64 -d > ${CERT_DST}`);

  // Verify
  const result = await d.shell(`ls -la ${CERT_DST}`);
  console.log('   ' + result.toString().trim());

  // Step 3: Set permissions
  console.log('3. Setting permissions...');
  await d.shell(`chmod 644 ${CERT_DST}`);
  await d.shell(`chown root:root ${CERT_DST}`);
  console.log('   Done');

  // Step 4: Remount /system as ro
  console.log('4. Remounting /system as ro...');
  await d.shell('mount -o ro,remount /system');
  console.log('   Done');

  // Step 5: List cert to confirm
  console.log('5. Verification:');
  const verify = await d.shell(`ls -la /system/etc/security/cacerts/${CERT_HASH}*`);
  console.log('   ' + verify.toString().trim());

  console.log('\n✓ Certificate installed!');
  console.log('Now restart MuMu or reboot for changes to take effect.');

} catch(e) {
  console.error('Error:', e.message);
} finally {
  await Promise.allSettled(ds.map(c => c.close()));
}
