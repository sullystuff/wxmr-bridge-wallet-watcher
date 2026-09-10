import bs58 from 'bs58';
import { idl, manifest } from '../src/config.js';

export const program = manifest.solana.programId;
export function eventBytes(name, data) {
  const definition = idl.events.find(event => event.name === name);
  const fields = idl.types.find(type => type.name === name).type.fields;
  const parts = [Buffer.from(definition.discriminator)];
  for (const field of fields) {
    const value = data[field.name];
    if (field.type === 'pubkey') parts.push(Buffer.from(bs58.decode(value)));
    else if (field.type === 'string') {
      const text = Buffer.from(value); const length = Buffer.alloc(4); length.writeUInt32LE(text.length); parts.push(length, text);
    } else if (field.type === 'u64' || field.type === 'i64') {
      const bytes = Buffer.alloc(8);
      if (field.type === 'u64') bytes.writeBigUInt64LE(BigInt(value)); else bytes.writeBigInt64LE(BigInt(value));
      parts.push(bytes);
    } else if (field.type === 'bool') parts.push(Buffer.from([value ? 1 : 0]));
    else throw new Error(`Unsupported test field ${field.type}`);
  }
  return Buffer.concat(parts);
}
export function eventLogs(name, data) {
  return [`Program ${program} invoke [1]`, `Program data: ${eventBytes(name, data).toString('base64')}`, `Program ${program} success`];
}
export const mint = { deposit_pda: program, owner: manifest.solana.mint, amount: '9007199254740993', total_deposited: '9007199254740993' };
