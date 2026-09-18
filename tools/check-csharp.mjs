#!/usr/bin/env node
/**
 * Compile the C# game adapters against the real ScriptHookDotNet assembly.
 *
 * The Script Hook compiles plain .cs scripts at game start, and a compile error
 * there shows up as "the mod silently did nothing" plus a line in
 * ScriptHookDotNet.log. Catching it here costs a second instead of a game load.
 *
 * Needs the .NET Framework 4 compiler, which ships with Windows. Skips (rather
 * than fails) when the compiler or the reference assembly is missing, so the
 * suite still runs on a machine without GTA IV installed.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, copyFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const CSC = 'C:/Windows/Microsoft.NET/Framework/v4.0.30319/csc.exe';

const ADAPTERS = [
  {
    name: 'gta4',
    source: path.join(root, 'adapters/gta4/game-mod/ChaosEngine.cs'),
    // Shipped with the Script Hook, under the game's scripts folder.
    reference: [
      'C:/Games/Grand Theft Auto IV/GTAIV/scripts/for Developers/bin/ScriptHookDotNet.dll',
      process.env['GTA4_DIR'] ? path.join(process.env['GTA4_DIR'], 'scripts/for Developers/bin/ScriptHookDotNet.dll') : null,
    ],
  },
];

if (!existsSync(CSC)) {
  console.log('csc.exe for .NET Framework 4 not found, skipping the C# check');
  process.exit(0);
}

let failures = 0;
let checked = 0;

for (const adapter of ADAPTERS) {
  if (!existsSync(adapter.source)) continue;

  const reference = adapter.reference.filter(Boolean).find((p) => existsSync(p));
  if (!reference) {
    console.log(`${adapter.name}: ScriptHookDotNet.dll not found, skipping (set GTA4_DIR to check it)`);
    continue;
  }

  // Copy the reference out of the game folder: a DLL downloaded from the
  // internet carries a mark-of-the-web that makes the compiler refuse it.
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'chaos-csc-'));
  try {
    const localRef = path.join(tmp, 'ScriptHookDotNet.dll');
    copyFileSync(reference, localRef);

    execFileSync(
      CSC,
      [
        '-nologo',
        '-target:library',
        '-platform:x86',
        '-langversion:4',
        `-out:${path.join(tmp, 'out.dll')}`,
        `-r:${localRef}`,
        '-r:System.dll',
        '-r:System.Drawing.dll',
        '-r:System.Windows.Forms.dll',
        adapter.source,
      ],
      { stdio: 'pipe' },
    );
    checked++;
    console.log(`${adapter.name}: compiles clean`);
  } catch (err) {
    failures++;
    console.error(`${adapter.name}: does not compile\n`);
    console.error(String(err.stdout ?? '') + String(err.stderr ?? ''));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (checked === 0 && failures === 0) {
  console.log('no C# adapters could be checked on this machine');
}
process.exit(failures === 0 ? 0 : 1);
