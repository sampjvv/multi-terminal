const fs = require('fs');
const path = require('path');

exports.default = async function afterPack(context) {
  const unpackedDir = path.join(
    context.appOutDir,
    'resources',
    'app.asar.unpacked',
    'node_modules',
    'node-pty',
    'build',
    'Release',
    'conpty'
  );

  const sourceDir = path.join(
    context.packager.projectDir,
    'node_modules',
    'node-pty',
    'third_party',
    'conpty'
  );

  // Find the version folder (e.g. "1.23.251008001")
  const versions = fs.readdirSync(sourceDir);
  if (versions.length === 0) {
    console.warn('afterPack: no conpty version folder found');
    return;
  }

  const arch = context.arch === 1 ? 'x64' : 'arm64'; // electron-builder: 1=x64, 3=arm64
  const platformDir = path.join(sourceDir, versions[0], `win10-${arch}`);

  fs.mkdirSync(unpackedDir, { recursive: true });

  for (const file of ['conpty.dll', 'OpenConsole.exe']) {
    const src = path.join(platformDir, file);
    const dest = path.join(unpackedDir, file);
    console.log(`afterPack: copying ${src} -> ${dest}`);
    fs.copyFileSync(src, dest);
  }
};
