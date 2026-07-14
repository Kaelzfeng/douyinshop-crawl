// Enumerate all loaded modules, highlighting security-related ones
'use strict';

const modules = Process.enumerateModules();
send({ totalModules: modules.length });

const interesting = modules.filter(m =>
  /metasec|encrypt|sgmain|krypton|sheo|ttcrypto|ttnet|cronet|sign|sec|houdini|nativebridge/i.test(m.name)
);

send({ interestingCount: interesting.length });
send({ pid: Process.id, arch: Process.arch });

for (let i = 0; i < interesting.length; i++) {
  const m = interesting[i];
  send({
    name: m.name,
    base: m.base.toString(),
    size: m.size,
    sizeKb: (m.size / 1024).toFixed(0),
    path: m.path.slice(0, 200),
  });
}

// Also dump ALL module names (compact)
const allNames = modules.map(m => m.name).sort();
send({ allModuleNames: allNames.slice(0, 200) });
send({ allModulesCount: allNames.length });
send({ done: true });
