import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  totp,
  totpProvisioningUri,
  verifyTotp,
} from './totp';

// RFC 6238 test secret: ASCII "12345678901234567890"
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890', 'ascii'));

const RFC_VECTORS: Array<[number, string]> = [
  [59, '287082'],
  [1111111109, '081804'],
  [1111111111, '050471'],
  [1234567890, '005924'],
  [2000000000, '279037'],
  [20000000000, '353130'],
];

describe('totp (RFC 6238)', () => {
  it('base32-encodes the RFC secret correctly', () => {
    expect(RFC_SECRET).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  });

  it('base32 round-trips back to the original bytes', () => {
    expect(base32Decode(RFC_SECRET).toString('ascii')).toBe('12345678901234567890');
  });

  it.each(RFC_VECTORS)('produces %s at T=%i', (time, expected) => {
    expect(totp(RFC_SECRET, time)).toBe(expected);
  });

  it('verifies the current code and rejects an invalid one', () => {
    const code = totp(RFC_SECRET);
    expect(verifyTotp(RFC_SECRET, code)).toBe(true);
    expect(verifyTotp(RFC_SECRET, '000000')).toBe(false);
    expect(verifyTotp(RFC_SECRET, '12345')).toBe(false);
  });

  it('generates distinct random secrets and valid provisioning URIs', () => {
    const a = generateTotpSecret();
    const b = generateTotpSecret();
    expect(a).not.toBe(b);
    expect(base32Decode(a).length).toBe(20);
    const uri = totpProvisioningUri(a, 'admin', 'Northern Province Gov');
    expect(uri).toContain(`secret=${a}`);
    expect(uri.startsWith('otpauth://totp/')).toBe(true);
  });
});
