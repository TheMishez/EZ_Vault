'use strict';
// Flips Electron "fuses" in the packaged EZ Vault.exe so the binary can't be abused to run
// arbitrary code or be attached to by a debugger to read secrets from memory.
const path = require('path');
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');

exports.default = async function afterPack(context) {
  const ext = { darwin: '.app', win32: '.exe', linux: '' }[context.electronPlatformName];
  const exe = path.join(context.appOutDir, context.packager.appInfo.productFilename + ext);
  await flipFuses(exe, {
    version: FuseVersion.V1,
    resetAdHocDarwinSignature: context.electronPlatformName === 'darwin',
    [FuseV1Options.RunAsNode]: false,                          // ELECTRON_RUN_AS_NODE can't turn the exe into a Node shell
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false, // NODE_OPTIONS can't inject code
    [FuseV1Options.EnableNodeCliInspectArguments]: false,      // --inspect can't attach a debugger
    [FuseV1Options.OnlyLoadAppFromAsar]: true,                 // only the shipped app code runs
    [FuseV1Options.EnableCookieEncryption]: true
  });
  console.log('  • EZ Vault fuses flipped:', exe);
};
