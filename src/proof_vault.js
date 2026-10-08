import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// Store receipt tokens encrypted for later refund checks. Keep this key in the
// hosting secret manager, separate from the database and its backups.
export class ProofVault {
  constructor(hexKey) {
    if (!/^[a-fA-F0-9]{64}$/.test(hexKey ?? '')) throw new Error('RECEIPT_ENCRYPTION_KEY must be a 32-byte hex secret');
    this.key = Buffer.from(hexKey, 'hex');
  }
  seal(value) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
  }
  open(value) {
    const data = Buffer.from(value, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', this.key, data.subarray(0, 12));
    decipher.setAuthTag(data.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8'));
  }
}
