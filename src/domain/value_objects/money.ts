// =============================================================================
// Money value object
// -----------------------------------------------------------------------------
// Mirrors the proto `lapc506.payments_core.v1.Money` message. The domain holds
// amounts as `bigint` rather than `number` because:
//
//   1. Card-issuer ledgers routinely exceed Number.MAX_SAFE_INTEGER when the
//      currency is COP, VND, or similar low-denomination units.
//   2. Float arithmetic is unsound at cent precision. `0.1 + 0.2 !== 0.3`.
//
// ts-proto emits `string` for int64 by default. The grpc translator in
// `src/adapters/inbound/grpc/translators.ts` (landing with `grpc-server-inbound`)
// bridges string ↔ bigint at the transport boundary. The domain itself never
// sees the string form.
//
// Invariants enforced in the smart constructor `Money.of`:
//   - amount >= 0
//   - currency is exactly three uppercase A-Z letters (ISO 4217 shape)
//
// Actual ISO-4217 existence is not checked here — that list drifts faster than
// we can update. The application layer validates against a seeded table.
// =============================================================================

import { CurrencyMismatchError, InvalidMoneyError, type Result, err, ok } from '../errors.js';

/**
 * Immutable amount + currency pair. Construct via `Money.of` (throws) or
 * `Money.create` (returns Result<Money, InvalidMoneyError>).
 */
export class Money {
  public readonly amountMinor: bigint;
  public readonly currency: string;

  private constructor(amountMinor: bigint, currency: string) {
    this.amountMinor = amountMinor;
    this.currency = currency;
  }

  /**
   * Throw-on-invalid constructor, preferred inside already-validated code
   * paths (tests, internal transitions).
   */
  static of(amountMinor: bigint, currency: string): Money {
    const result = Money.create(amountMinor, currency);
    if (!result.ok) {
      throw result.error;
    }
    return result.value;
  }

  /**
   * Result-returning constructor, preferred on external boundaries where the
   * caller wants to accumulate validation errors rather than catch exceptions.
   */
  static create(
    amountMinor: bigint,
    currency: string,
  ): Result<Money, InvalidMoneyError> {
    if (typeof amountMinor !== 'bigint') {
      return err(
        new InvalidMoneyError('amountMinor must be a bigint (use the n suffix or BigInt(...))'),
      );
    }
    if (amountMinor < 0n) {
      return err(new InvalidMoneyError(`amountMinor must be non-negative; got ${amountMinor}`));
    }
    if (!/^[A-Z]{3}$/.test(currency)) {
      return err(
        new InvalidMoneyError(
          `currency must be three uppercase ASCII letters (ISO 4217); got '${currency}'`,
        ),
      );
    }
    return ok(new Money(amountMinor, currency));
  }

  /**
   * Additive composition. Rejects cross-currency addition.
   */
  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.amountMinor + other.amountMinor, this.currency);
  }

  /**
   * Subtractive composition. Rejects cross-currency subtraction. Returns
   * Result because underflow is a runtime-checkable caller error (refund
   * exceeds charge, platform fee exceeds escrow amount, etc.).
   */
  subtract(other: Money): Result<Money, InvalidMoneyError> {
    if (this.currency !== other.currency) {
      return err(new CurrencyMismatchError(this.currency, other.currency));
    }
    if (this.amountMinor < other.amountMinor) {
      return err(
        new InvalidMoneyError(
          `Subtraction would underflow: ${this.amountMinor} - ${other.amountMinor}`,
        ),
      );
    }
    return ok(new Money(this.amountMinor - other.amountMinor, this.currency));
  }

  /**
   * Value equality. Zero USD and zero CRC are NOT equal — equality requires
   * matching currency.
   */
  equals(other: Money): boolean {
    return this.amountMinor === other.amountMinor && this.currency === other.currency;
  }

  isZero(): boolean {
    return this.amountMinor === 0n;
  }

  toString(): string {
    return `${this.amountMinor.toString()} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}
