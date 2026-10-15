import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';

const maxBytes = 16 * 1024 * 1024;
// Plugin updates can remove the running server's cache directory.
const clipboardCommand = Buffer.from(readFileSync(new URL('./clipboard.ps1', import.meta.url), 'utf8'), 'utf16le').toString('base64');
function imageData(value: string, mime: string) {
  if (typeof value !== 'string' || value.length > maxBytes * 3) throw new Error('Plot clipboard image exceeds 16 MiB.');
  const comma = value.indexOf(','), header = value.slice(0, comma).toLowerCase().split(';'), encoded = value.slice(comma + 1);
  if (comma < 0 || header[0] !== `data:${mime}` || header.slice(1).some(part => !['base64', 'charset=utf-8'].includes(part)))
    throw new Error(`Expected a ${mime} data URI.`);
  if (header.includes('base64') && !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error('Invalid clipboard image encoding.');
  const bytes = header.includes('base64') ? Buffer.from(encoded, 'base64') : Buffer.from(decodeURIComponent(encoded), 'utf8');
  if (!bytes.length || bytes.length > maxBytes) throw new Error('Plot clipboard image exceeds 16 MiB.');
  return bytes;
}

export async function copyPlot(svg: string, png: string): Promise<{ format: 'svg'; fallback: 'png' }> {
  if (process.platform !== 'win32') throw new Error('Native Plot clipboard copy is available on Windows.');
  const vector = imageData(svg, 'image/svg+xml').toString('utf8'), bitmap = imageData(png, 'image/png');
  if (!/^\s*(?:<\?xml[\s\S]*?\?>\s*)?<svg(?:\s|>)/i.test(vector) || vector.includes('\0')) throw new Error('Invalid SVG Plot.');
  if (bitmap.length < 33 || !bitmap.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      bitmap.readUInt32BE(8) !== 13 || bitmap.toString('ascii', 12, 16) !== 'IHDR') throw new Error('Invalid PNG Plot.');
  const width = bitmap.readUInt32BE(16), height = bitmap.readUInt32BE(20);
  if (!width || !height || width * height > 16000000) throw new Error('Clipboard PNG exceeds 16 megapixels.');
  return new Promise((resolve, reject) => {
    const child = execFile('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', clipboardCommand],
      { windowsHide: true, timeout: 20000, maxBuffer: 65536 }, (error, _stdout, stderr) => {
        if (error) reject(new Error(stderr.trim() || error.message));
        else resolve({ format: 'svg', fallback: 'png' });
      });
    child.stdin!.on('error', reject);
    child.stdin!.end(JSON.stringify({ svg: vector, png: bitmap.toString('base64') }));
  });
}
