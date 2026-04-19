// =============================================================================
// Value object tests
// -----------------------------------------------------------------------------
// Covers:
//   - Money construction (valid + invalid currency + negative amount + non-bigint)
//   - Money arithmetic (add / subtract / equals / isZero / toString)
//   - Money cross-currency rejection
//   - IdempotencyKey format validation (length + charset)
//   - GatewayRef and ThreeDSChallenge constructors
// =============================================================================

import { describe, expect, it } from 'vitest';

import {
  CurrencyMismatchError,
  InvalidMoneyError,
} from '../../src/domain/errors.js';
import {
  InvalidIdempotencyKeyError,
  Money,
  createGatewayRef,
  createIdempotencyKey,
  createThreeDSChallenge,
  gatewayRefEquals,
  idempotencyKey,
} from '../../src/domain/index.js';

describe('Money', () => {
  it('constructs with valid bigint + ISO currency', () => {
    const m = Money.of(1234n, 'USD');
    expect(m.amountMinor).toBe(1234n);
    expect(m.currency).toBe('USD');
  });

  it('rejects negative amounts', () => {
    expect(() => Money.of(-1n, 'USD')).toThrowError(InvalidMoneyError);
    const r = Money.create(-1n, 'USD');
    expect(r.ok).toBe(false);
  });

  it('rejects non-ISO-4217 currency shape', () => {
    expect(() => Money.of(100n, 'usd')).toThrowError(InvalidMoneyError);
    expect(() => Money.of(100n, 'US')).toThrowError(InvalidMoneyError);
    expect(() => Money.of(100n, 'USDT')).toThrowError(InvalidMoneyError);
    expect(() => Money.of(100n, '')).toThrowError(InvalidMoneyError);
  });

  it('rejects non-bigint amount via Result path', () => {
    // Simulate a caller passing a number that leaked through a weak boundary.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = Money.create(42 as any, 'USD');
    expect(r.ok).toBe(false);
  });

  it('adds same-currency values', () => {
    const a = Money.of(100n, 'USD');
    const b = Money.of(50n, 'USD');
    expect(a.add(b).amountMinor).toBe(150n);
  });

  it('rejects cross-currency addition', () => {
    const a = Money.of(100n, 'USD');
    const b = Money.of(50n, 'CRC');
    expect(() => a.add(b)).toThrowError(CurrencyMismatchError);
  });

  it('subtracts same-currency values and rejects underflow', () => {
    const a = Money.of(100n, 'USD');
    const b = Money.of(30n, 'USD');
    const ok = a.subtract(b);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.value.amountMinor).toBe(70n);
    }

    const underflow = b.subtract(a);
    expect(underflow.ok).toBe(false);
  });

  it('returns CurrencyMismatch on cross-currency subtraction', () => {
    const a = Money.of(100n, 'USD');
    const b = Money.of(50n, 'CRC');
    const r = a.subtract(b);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBeInstanceOf(CurrencyMismatchError);
    }
  });

  it('equality respects both amount and currency', () => {
    const a = Money.of(0n, 'USD');
    const b = Money.of(0n, 'CRC');
    const c = Money.of(0n, 'USD');
    expect(a.equals(c)).toBe(true);
    expect(a.equals(b)).toBe(false);
  });

  it('isZero matches amount 0 regardless of currency', () => {
    expect(Money.of(0n, 'USD').isZero()).toBe(true);
    expect(Money.of(1n, 'USD').isZero()).toBe(false);
  });

  it('toString is stable', () => {
    expect(Money.of(1234n, 'USD').toString()).toBe('1234 USD');
  });

  it('handles bigint values beyond Number.MAX_SAFE_INTEGER', () => {
    const huge = 9_007_199_254_740_993n; // Number.MAX_SAFE_INTEGER + 2
    const a = Money.of(huge, 'COP');
    const b = Money.of(1n, 'COP');
    expect(a.add(b).amountMinor).toBe(huge + 1n);
  });
});

describe('IdempotencyKey', () => {
  it('accepts valid keys 8..128 chars of [A-Za-z0-9_-:]', () => {
    expect(createIdempotencyKey('abcdefgh').ok).toBe(true);
    expect(createIdempotencyKey('intent:123-xyz_A').ok).toBe(true);
    const long = 'a'.repeat(128);
    expect(createIdempotencyKey(long).ok).toBe(true);
  });

  it('rejects keys shorter than 8 chars', () => {
    expect(createIdempotencyKey('short').ok).toBe(false);
    expect(createIdempotencyKey('').ok).toBe(false);
  });

  it('rejects keys longer than 128 chars', () => {
    const tooLong = 'a'.repeat(129);
    const r = createIdempotencyKey(tooLong);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBeInstanceOf(InvalidIdempotencyKeyError);
    }
  });

  it('rejects disallowed characters', () => {
    expect(createIdempotencyKey('has spaces1').ok).toBe(false);
    expect(createIdempotencyKey('has/slash1').ok).toBe(false);
    expect(createIdempotencyKey('has.period').ok).toBe(false);
    expect(createIdempotencyKey('hasunicod\u00e9').ok).toBe(false);
  });

  it('throws via the bang variant on invalid input', () => {
    expect(() => idempotencyKey('short')).toThrowError(InvalidIdempotencyKeyError);
  });
});

describe('GatewayRef', () => {
  it('accepts known gateway names', () => {
    const r = createGatewayRef('stripe', 'pi_123');
    expect(r.ok).toBe(true);
  });

  it('rejects unknown gateway names', () => {
    expect(createGatewayRef('monzo', 'pi_123').ok).toBe(false);
  });

  it('rejects empty external ids', () => {
    expect(createGatewayRef('stripe', '').ok).toBe(false);
  });

  it('equality compares gateway and externalId', () => {
    const a = createGatewayRef('stripe', 'pi_1');
    const b = createGatewayRef('stripe', 'pi_1');
    const c = createGatewayRef('stripe', 'pi_2');
    const d = createGatewayRef('onvopay', 'pi_1');
    if (a.ok && b.ok && c.ok && d.ok) {
      expect(gatewayRefEquals(a.value, b.value)).toBe(true);
      expect(gatewayRefEquals(a.value, c.value)).toBe(false);
      expect(gatewayRefEquals(a.value, d.value)).toBe(false);
    }
  });
});

describe('ThreeDSChallenge', () => {
  it('accepts a non-empty id and Uint8Array payload', () => {
    const r = createThreeDSChallenge('ch_1', new Uint8Array([1, 2, 3]));
    expect(r.ok).toBe(true);
  });

  it('rejects empty challenge id', () => {
    expect(createThreeDSChallenge('', new Uint8Array()).ok).toBe(false);
  });

  it('rejects non-Uint8Array data', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = createThreeDSChallenge('ch_1', 'not-bytes' as any);
    expect(r.ok).toBe(false);
  });
});
