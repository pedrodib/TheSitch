const { build, Platform } = require('electron-builder');
const platform = { darwin: Platform.MAC, win32: Platform.WINDOWS, linux: Platform.LINUX }[process.platform];
if (!platform) throw new Error('Unsupported operating system');
build({ targets: platform.createTarget(['zip']), publish: 'never' }).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
