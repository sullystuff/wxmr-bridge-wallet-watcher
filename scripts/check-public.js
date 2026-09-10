import { execFileSync } from 'node:child_process';
import { readFileSync, lstatSync } from 'node:fs';
import { manifest } from '../src/config.js';

const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const allowedHex = new Set([manifest.monero.publishedViewKey, manifest.idl.sha256]);
const problems = [];
for (const file of new Set(files)) {
  if (lstatSync(file).isSymbolicLink()) { problems.push(`${file}: symlink`); continue; }
  if (/(^|\/)(data|node_modules|backups)(\/|$)|\.(keys|db|sqlite|log)$|(^|\/)\.env(?!\.example$)/.test(file)) {
    problems.push(`${file}: runtime or secret-bearing file`); continue;
  }
  const text = readFileSync(file, 'utf8');
  for (const match of text.matchAll(/\b[a-fA-F0-9]{64}\b/g)) {
    if (!allowedHex.has(match[0])) problems.push(`${file}: unproven 32-byte hex literal`);
  }
  if (/\[\s*(?:\d{1,3}\s*,\s*){63}\d{1,3}\s*\]/.test(text)) problems.push(`${file}: possible serialized signing key`);
  if (/(?:api[-_]?key|access_token)=[A-Za-z0-9_-]{12,}/i.test(text)) problems.push(`${file}: possible RPC credential`);
  if (text.includes('-----BEGIN ' + 'PRIVATE KEY-----')) problems.push(`${file}: private key block`);
}
if (problems.length) { console.error(problems.join('\n')); process.exitCode = 1; }
else console.log(`Checked ${new Set(files).size} repository files. Only the documented public view key and IDL hash are allowed as 32-byte hex literals.`);
