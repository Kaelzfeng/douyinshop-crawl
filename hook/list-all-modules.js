// List ALL modules with their full paths
'use strict';
const modules = Process.enumerateModules();
send({ total: modules.length });

// Filter for anything that's not a standard Android system library
const nonSystem = modules.filter(m =>
  !m.path.startsWith('/system/') &&
  !m.path.startsWith('/apex/') &&
  !m.path.startsWith('/vendor/')
);

send({ nonSystemCount: nonSystem.length });
for (let i = 0; i < nonSystem.length; i++) {
  const m = nonSystem[i];
  send({ idx: i, name: m.name, sizeKb: (m.size/1024).toFixed(0), path: m.path.slice(0, 250) });
}

// Also list all modules with 'tt', 'bd', 'byte', 'meta', 'sec', 'sign', 'encrypt' in name
const keywordMods = modules.filter(m =>
  /tt|bd|byte|meta|sec|sign|encrypt|ss|aweme/i.test(m.name)
);
send({ keywordCount: keywordMods.length });
for (let i = 0; i < keywordMods.length; i++) {
  send({ keyword: keywordMods[i].name, path: keywordMods[i].path.slice(0, 250) });
}

send({ done: true });
