import bs58 from 'bs58';
import { idl, manifest } from './config.js';

class Reader {
  constructor(bytes) { this.bytes = Buffer.from(bytes); this.offset = 0; }
  take(length) {
    if (!Number.isSafeInteger(length) || length < 0 || this.offset + length > this.bytes.length) throw new Error('Truncated Borsh data');
    const part = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return part;
  }
  read(type) {
    if (type === 'pubkey') return bs58.encode(this.take(32));
    if (type === 'u64') return this.take(8).readBigUInt64LE().toString();
    if (type === 'i64') return this.take(8).readBigInt64LE().toString();
    if (type === 'u32') return this.take(4).readUInt32LE();
    if (type === 'u16') return this.take(2).readUInt16LE();
    if (type === 'u8') return this.take(1)[0];
    if (type === 'bool') {
      const n = this.read('u8');
      if (n > 1) throw new Error('Invalid Borsh bool');
      return n === 1;
    }
    if (type === 'string') return new TextDecoder('utf-8', { fatal: true }).decode(this.take(this.read('u32')));
    if (type?.defined) return this.defined(type.defined.name);
    throw new Error('Unsupported public schema type');
  }
  defined(name) {
    const definition = idl.types.find(item => item.name === name)?.type;
    if (!definition) throw new Error('Unknown public schema type');
    if (definition.kind === 'enum') {
      const variant = definition.variants[this.read('u8')];
      if (!variant || variant.fields) throw new Error('Unknown enum variant');
      return variant.name;
    }
    return Object.fromEntries(definition.fields.map(field => [field.name, this.read(field.type)]));
  }
}

export function decode(bytes, kind) {
  const reader = new Reader(bytes);
  const discriminator = reader.take(8);
  const definition = idl[kind].find(item => discriminator.equals(Buffer.from(item.discriminator)));
  if (!definition) return null;
  const data = reader.defined(definition.name);
  if (kind === 'events' && reader.offset !== reader.bytes.length) throw new Error('Event schema has changed');
  return { name: definition.name, data };
}

export function decodeLogs(logs, programId = manifest.solana.programId) {
  if (!Array.isArray(logs)) throw new Error('Transaction logs unavailable');
  const stack = [];
  const events = [];
  for (const [index, line] of logs.entries()) {
    if (/log truncated/i.test(line)) throw new Error('Truncated transaction logs');
    const invoke = /^Program (\w+) invoke \[(\d+)\]$/.exec(line);
    if (invoke) {
      if (Number(invoke[2]) !== stack.length + 1) throw new Error('Incomplete invocation stack');
      stack.push({ program: invoke[1], events: [] });
      continue;
    }
    const end = /^Program (\w+) (success|failed:.*)$/.exec(line);
    if (end) {
      const frame = stack.pop();
      if (!frame || frame.program !== end[1]) throw new Error('Incomplete invocation stack');
      if (end[2] === 'success') (stack.at(-1)?.events ?? events).push(...frame.events);
      continue;
    }
    if (line.startsWith('Program data: ') && stack.at(-1)?.program === programId) {
      const bytes = Buffer.from(line.slice(14), 'base64');
      const event = decode(bytes, 'events');
      if (!event) throw new Error('Unrecognized bridge event; refresh the public IDL');
      stack.at(-1).events.push({ index, ...event });
    }
  }
  if (stack.length) throw new Error('Incomplete transaction logs');
  return events;
}

export function auditAddresses(transaction) {
  const instructions = [
    ...(transaction.transaction?.message?.instructions ?? []),
    ...(transaction.meta?.innerInstructions ?? []).flatMap(group => group.instructions),
  ];
  const addresses = new Set();
  for (const ix of instructions) {
    if (ix.programId !== manifest.solana.programId || !ix.data || !Array.isArray(ix.accounts)) continue;
    const discriminator = Buffer.from(bs58.decode(ix.data)).subarray(0, 8);
    const definition = idl.instructions.find(item => Buffer.from(item.discriminator).equals(discriminator));
    const index = definition?.accounts.findIndex(account => account.name === 'audit') ?? -1;
    if (index >= 0) addresses.add(ix.accounts[index]);
  }
  return [...addresses];
}
