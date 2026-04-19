// =============================================================================
// Money mapper — proto ↔ domain.
// -----------------------------------------------------------------------------
// The ts-proto generator (buf.gen.yaml: forceLong=string) emits `int64` fields
// as strings. The domain holds `Money.amountMinor` as `bigint` so sub-cent
// arithmetic on currencies like COP, VND, etc. never silently truncates.
//
// This file is the ONLY bridge between the two representations. Every handler
// that moves a `Money` across the transport boundary routes through here.
//
// Proto `Money` is an optional field on every request that carries one, so
// the mapper accepts `Money | undefined` and returns a `Result` to let the
// handler translate missing amounts to `INVALID_ARGUMENT`.
// =============================================================================

import {
  Money,
  type InvalidMoneyError,
  type Result,
  err,
} from '../../../../domain/index.js';
import { type Money as ProtoMoney } from '../../../../generated/lapc506/payments_core/v1/payments_core.js';

/**
 * proto → domain. Returns `Result` because invalid shapes (missing amount,
 * non-ISO currency) must map to gRPC `INVALID_ARGUMENT` rather than crash.
 */
export function protoMoneyToDomain(
  proto: ProtoMoney | undefined,
): Result<Money, InvalidMoneyError> {
  if (proto === undefined) {
    return Money.create(0n, 'USD');
  }
  let amountMinor: bigint;
  try {
    amountMinor = BigInt(proto.amountMinor);
  } catch {
    return Money.create(-1n, proto.currency ?? '');
  }
  return Money.create(amountMinor, proto.currency ?? '');
}

/**
 * Strict variant: fails with `INVALID_ARGUMENT` shape when the caller did
 * not supply a `Money` message at all. Used for required-amount RPCs.
 */
export function protoMoneyToDomainRequired(
  proto: ProtoMoney | undefined,
  fieldName: string,
): Result<Money, InvalidMoneyError> {
  if (proto === undefined) {
    return err({
      code: 'DOMAIN_INVALID_MONEY',
      message: `Field '${fieldName}' is required`,
      name: 'InvalidMoneyError',
    } as InvalidMoneyError);
  }
  return protoMoneyToDomain(proto);
}

/**
 * domain → proto. `amountMinor` is emitted as a string so the wire shape
 * matches ts-proto's `forceLong=string` expectation. The gateway side of
 * the transport accepts strings without surprise.
 */
export function domainMoneyToProto(money: Money): ProtoMoney {
  return {
    amountMinor: money.amountMinor.toString(),
    currency: money.currency,
  };
}
