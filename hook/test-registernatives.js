/**
 * Minimal test — find RegisterNatives in libart.so symbol table.
 */
'use strict';

send({ step: 'start', pid: Process.id, arch: Process.arch });

function tryFind() {
  send({ step: 'tryFind' });

  // Test 1: Module.findExportByName
  try {
    const addr1 = Module.findExportByName(null, 'RegisterNatives');
    send({ test: 'Module.findExportByName(null)', result: addr1 ? addr1.toString() : 'null' });
  } catch (e) {
    send({ test: 'Module.findExportByName(null)', error: String(e) });
  }

  // Test 2: Get libart
  let libart;
  try {
    libart = Process.getModuleByName('libart.so');
    send({ test: 'Process.getModuleByName(libart.so)', result: libart ? 'found base=' + libart.base : 'null' });
  } catch (e) {
    send({ test: 'Process.getModuleByName(libart.so)', error: String(e) });
    return;
  }

  // Test 3: enumerateSymbols type
  try {
    const enumFn = libart.enumerateSymbols;
    send({ test: 'libart.enumerateSymbols type', result: typeof enumFn });
  } catch (e) {
    send({ test: 'libart.enumerateSymbols type', error: String(e) });
  }

  // Test 4: Call enumerateSymbols
  let symbols;
  try {
    symbols = libart.enumerateSymbols();
    send({ test: 'libart.enumerateSymbols()', result: symbols ? 'got result type=' + typeof symbols : 'null/undefined' });
    send({ test: 'symbols type detail', isArray: Array.isArray(symbols), hasLength: typeof symbols.length, len: symbols ? symbols.length : -1 });
  } catch (e) {
    send({ test: 'libart.enumerateSymbols()', error: String(e) + ' stack=' + (e.stack||'').slice(0,200) });
    return;
  }

  // Test 5: Index access
  if (symbols && typeof symbols.length === 'number' && symbols.length > 0) {
    try {
      const s0 = symbols[0];
      send({ test: 'symbols[0]', result: typeof s0 + ' name=' + (s0 && s0.name ? String(s0.name).slice(0,50) : 'no name') });
    } catch (e) {
      send({ test: 'symbols[0] access', error: String(e) });
    }

    // Test 6: Search for RegisterNatives with indexed loop
    try {
      let found = null;
      for (let i = 0; i < symbols.length && i < 50000; i++) {
        try {
          const sym = symbols[i];
          if (sym && sym.name && typeof sym.name === 'string' && sym.name.indexOf('RegisterNatives') !== -1 && sym.name.indexOf('CheckJNI') === -1) {
            found = sym;
            break;
          }
        } catch (e) { /* skip */ }
      }
      send({ test: 'indexed loop search', result: found ? 'found: ' + found.name + ' at ' + found.address : 'not found in ' + symbols.length + ' symbols' });
    } catch (e) {
      send({ test: 'indexed loop search', error: String(e) + ' ' + (e.stack||'').slice(0,300) });
    }

    // Test 7: Try for...of (the original failing pattern)
    try {
      let found2 = null;
      for (const sym of symbols) {
        try {
          if (sym && sym.name && typeof sym.name === 'string' && sym.name.indexOf('RegisterNatives') !== -1 && sym.name.indexOf('CheckJNI') === -1) {
            found2 = sym;
            break;
          }
        } catch (e) { /* skip */ }
      }
      send({ test: 'for...of search', result: found2 ? 'found: ' + found2.name : 'not found' });
    } catch (e) {
      send({ test: 'for...of search', error: String(e) + ' ' + (e.stack||'').slice(0,300) });
    }
  }
}

setTimeout(tryFind, 1000);
