import frida from 'frida';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.resolve(__dirname, process.argv[2] || 'capture-share-api.js');
const outPath = path.resolve(process.cwd(), process.argv[3] || `output/share-api-capture-${Date.now()}.jsonl`);
const forcedPid = process.argv[4] ? Number(process.argv[4]) : 0;
const packageName = 'com.ss.android.ugc.livelite';
const scriptSource = fs.readFileSync(scriptPath, 'utf8');

function write(obj) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.appendFileSync(outPath, `${JSON.stringify(obj)}\n`, 'utf8');
  if (obj.type && !['uri-parse'].includes(obj.type)) {
    console.log(`[${obj.type}] ${obj.url || obj.uri || obj.text?.slice?.(0, 100) || obj.target || ''}`);
  }
}

async function main() {
  const manager = frida.getDeviceManager();
  const devices = await manager.enumerateDevices();
  let device = devices.find((d) => d.type === 'usb');
  if (!device) {
    device = await manager.addRemoteDevice('127.0.0.1:27042');
  }
  const processes = await device.enumerateProcesses();
  const proc = processes.find((p) => p.name === packageName)
    || processes.find((p) => p.name.toLowerCase().includes('livelite') && !p.name.includes(':'))
    || processes.find((p) => p.name.toLowerCase().includes('livelite'));
  const pid = forcedPid || (proc ? proc.pid : await device.spawn([packageName]));
  const session = await device.attach(pid);
  const script = await session.createScript(scriptSource);
  script.message.connect((message) => {
    if (message.type === 'send') {
      write(message.payload);
    } else {
      write({ type: 'frida-error', message });
      console.error(message.stack || message.description || JSON.stringify(message));
    }
  });
  await script.load();
  if (!forcedPid && !proc) await device.resume(pid);
  console.log(`[capture] attached pid=${pid}`);
  console.log(`[capture] writing ${outPath}`);
  process.stdin.resume();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
