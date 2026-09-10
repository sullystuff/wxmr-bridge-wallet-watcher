import { mkdirSync, openSync, writeFileSync, closeSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export function acquireLock(directory, name) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${name}.lock`);
  let fd;
  try { fd = openSync(path, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error(`A ${name} lock exists. If its process has exited, remove only that stale lock before restarting.`);
    throw error;
  }
  const value = JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() });
  writeFileSync(fd, value); closeSync(fd);
  return () => { if (readFileSync(path, 'utf8') === value) unlinkSync(path); };
}
