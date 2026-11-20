import install, { piPackage } from './extension.js';

export default function(pi) {
  return install(pi, async () => {
    try { return require('@earendil-works/pi-coding-agent'); } catch { return piPackage(); }
  });
}
