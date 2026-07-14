import { _android as android } from 'playwright';

const requestedSerial = process.env.MUMU_SERIAL || '127.0.0.1:16384';
const devices = await android.devices({ host: '127.0.0.1', port: 5037 });

try {
  const summaries = devices.map((device) => ({
    serial: device.serial(),
    model: device.model(),
  }));
  const device = devices.find((candidate) => candidate.serial() === requestedSerial);

  console.log(JSON.stringify({ requestedSerial, devices: summaries }, null, 2));
  if (!device) {
    throw new Error(`MuMu device ${requestedSerial} was not found.`);
  }

  const packagePid = (await device.shell('pidof com.ss.android.ugc.livelite')).toString().trim();
  const webViews = device.webViews().map((webView) => ({
    pkg: webView.pkg(),
    pid: webView.pid(),
  }));

  console.log(JSON.stringify({
    connected: true,
    serial: device.serial(),
    model: device.model(),
    douyinMallRunning: Boolean(packagePid),
    packagePid: packagePid || null,
    webViews,
  }, null, 2));
} finally {
  await Promise.allSettled(devices.map((device) => device.close()));
}
