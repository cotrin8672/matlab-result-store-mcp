import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const inline = text => text.replaceAll(/<\/script/gi, '<\\/script');
async function bundle(entry) {
  const result = await build({ entryPoints: [entry], bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', minify: true });
  return inline(result.outputFiles[0].text);
}
mkdirSync('dist', { recursive: true });
const plotly = inline(readFileSync('node_modules/plotly.js-dist-min/plotly.min.js', 'utf8'));
const mathjax = inline(readFileSync('node_modules/mathjax/es5/tex-svg-full.js', 'utf8'));
const assets = `<script>window.MathJax={svg:{fontCache:'local'},startup:{typeset:false}};</script><script>${mathjax}</script><script>${plotly}</script>`;
const appScript = await bundle('ui/browser.ts');
const browser = readFileSync('ui/browser.html', 'utf8').replace('<!-- plot-assets -->', () => assets).replace('<script>/* app-script */</script>', () => `<script type="module">${appScript}</script>`);
writeFileSync('dist/browser.html', browser);
const hostScript = await bundle('ui/preview.ts');
const preview = readFileSync('ui/preview.html', 'utf8').replace('<script>/* host-script */</script>', () => `<script type="module">${hostScript}</script>`);
writeFileSync('dist/preview.html', preview);
console.log('Built dist/browser.html and dist/preview.html');
