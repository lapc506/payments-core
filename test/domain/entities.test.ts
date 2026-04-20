// =============================================================================
// Entity state-machine tests
// -----------------------------------------------------------------------------
// Each entity gets:
//   - A happy-path transition test covering the longest legal chain.
//   - A guard test (`canTransition*`) enumerating a few legal vs illegal edges.
//   - At least one illegal-transition throw test that asserts
//     InvalidStateTransitionError.
//
// All tests are synchronous and pure — the domain layer does no I/O.
// =============================================================================

import { describe, expect, it } from 'vitest';

import {
  DisputeOngoingError,
  InvalidStateTransitionError,
} from '../../src/domain/errors.js';
import {
  Money,
  canTransitionDispute,
  canTransitionDonation,
  canTransitionEscrow,
  canTransitionPayout,
  canTransitionPaymentIntent,
  canTransitionRefund,
  canTransitionSubscription,
  createDispute,
  createDonation,
  createEscrow,
  createGatewayRef,
  createPaymentIntent,
  createPayout,
  createRefund,
  createSubscription,
  idempotencyKey,
  submitDisputeEvidence,
  transitionDispute,
  transitionDonation,
  transitionEscrow,
  transitionPayout,
  transitionPaymentIntent,
  transitionRefund,
  transitionSubscription,
} from '../../src/domain/index.js';

const key = idempotencyKey('abcdefgh1234');
const usd = (n: bigint) => Money.of(n, 'USD');
const gatewayRefOrThrow = (gateway: string, id: string) => {
  const r = createGatewayRef(gateway, id);
  if (!r.ok) throw r.error;
  return r.value;
};

// ---------------------------------------------------------------------------
// PaymentIntent
// ---------------------------------------------------------------------------

describe('PaymentIntent state machine', () => {
  const base = () =>
    createPaymentIntent({
      id: 'pi_1',
      consumer: 'altrupets',
      customerReference: 'user-42',
      amount: usd(1000n),
      idempotencyKey: key,
    });

  it('starts in intent status', () => {
    expect(base().status).toBe('intent');
  });

  it.each([
    ['intent', 'pending', true],
    ['intent', 'failed', true],
    ['intent', 'succeeded', false],
    ['pending', 'succeeded', true],
    ['pending', 'failed', true],
    ['pending', 'refunded', false],
    ['succeeded', 'refunded', true],
    ['succeeded', 'disputed', true],
    ['refunded', 'disputed', true],
    ['refunded', 'succeeded', false],
    ['disputed', 'refunded', false],
    ['failed', 'pending', false],
  ] as const)('canTransition(%s → %s) = %s', (from, to, expected) => {
    expect(canTransitionPaymentIntent(from, to)).toBe(expected);
  });

  it('advances through the longest legal chain', () => {
    let pi = base();
    pi = transitionPaymentIntent(pi, {
      to: 'pending',
      gatewayRef: gatewayRefOrThrow('stripe', 'pi_stripe_1'),
    });
    expect(pi.status).toBe('pending');
    expect(pi.gatewayRef?.externalId).toBe('pi_stripe_1');

    pi = transitionPaymentIntent(pi, { to: 'succeeded' });
    pi = transitionPaymentIntent(pi, { to: 'refunded' });
    pi = transitionPaymentIntent(pi, { to: 'disputed' });
    expect(pi.status).toBe('disputed');
  });

  it('throws InvalidStateTransitionError on illegal transitions', () => {
    const pi = base();
    expect(() => transitionPaymentIntent(pi, { to: 'refunded' })).toThrowError(
      InvalidStateTransitionError,
    );
  });
});

// ---------------------------------------------------------------------------
// Subscription
// ---------------------------------------------------------------------------

describe('Subscription state machine', () => {
  const base = () =>
    createSubscription({
      id: 'sub_1',
      consumer: 'dojo-os',
      customerReference: 'tenant-42',
      planId: 'plan_pro',
      idempotencyKey: key,
    });

  it.each([
    ['intent', 'active', true],
    ['intent', 'incomplete', true],
    ['incomplete', 'active', true],
    ['active', 'past_due', true],
    ['past_due', 'active', true],
    ['active', 'canceled', true],
    ['canceled', 'active', false],
    ['canceled', 'past_due', false],
  ] as const)('canTransition(%s → %s) = %s', (from, to, expected) => {
    expect(canTransitionSubscription(from, to)).toBe(expected);
  });

  it('recovers from past_due back to active', () => {
    let sub = base();
    sub = transitionSubscription(sub, { to: 'active' });
    sub = transitionSubscription(sub, { to: 'past_due' });
    sub = transitionSubscription(sub, { to: 'active' });
    expect(sub.status).toBe('active');
  });

  it('rejects resurrection from canceled', () => {
    let sub = base();
    sub = transitionSubscription(sub, { to: 'active' });
    sub = transitionSubscription(sub, { to: 'canceled' });
    expect(() => transitionSubscription(sub, { to: 'active' })).toThrowError(
      InvalidStateTransitionError,
    );
  });
});

// ---------------------------------------------------------------------------
// Escrow
// ---------------------------------------------------------------------------

describe('Escrow state machine', () => {
  const base = () =>
    createEscrow({
      id: 'esc_1',
      consumer: 'aduanext-api',
      payerReference: 'pyme-42',
      payeeReference: 'broker-7',
      amount: Money.of(150_000n, 'CRC'),
      idempotencyKey: key,
      milestoneCondition: {
        milestones: ['dua_signed', 'levante_received'],
        releaseSplit: [50, 50],
      },
      platformFeeMinor: 15_000n,
      platformFeeDestination: 'aduanext-platform-account',
    });

  it('records aduanext milestone + platform-fee metadata', () => {
    const e = base();
    expect(e.status).toBe('held');
    expect(e.milestoneCondition?.milestones).toEqual(['dua_signed', 'levante_received']);
    expect(e.platformFeeMinor).toBe(15_000n);
    expect(e.platformFeeDestination).toBe('aduanext-platform-account');
  });

  it.each([
    ['held', 'released', true],
    ['held', 'refunded', true],
    ['held', 'disputed', true],
    ['released', 'refunded', false],
    ['disputed', 'released', true],
    ['disputed', 'refunded', true],
    ['refunded', 'released', false],
  ] as const)('canTransition(%s → %s) = %s', (from, to, expected) => {
    expect(canTransitionEscrow(from, to)).toBe(expected);
  });

  it('raises DisputeOngoingError when a disputed escrow is pushed to a non-resolution state', () => {
    let e = base();
    e = transitionEscrow(e, { to: 'disputed' });
    // `held` is illegal from `disputed`. The domain raises the explicit
    // DisputeOngoingError rather than a generic InvalidStateTransitionError
    // because the fix is operational (resolve the dispute first).
    expect(() => transitionEscrow(e, { to: 'held' })).toThrowError(DisputeOngoingError);
  });

  it('resolves a dispute to released', () => {
    let e = base();
    e = transitionEscrow(e, { to: 'disputed' });
    e = transitionEscrow(e, { to: 'released' });
    expect(e.status).toBe('released');
  });

  // Partial-release + milestone semantics spec'd in
  // `openspec/changes/escrow-port/design.md` § Milestone conditions and
  // § State machine. The domain itself is stateless across `release` calls
  // — these tests pin the contract the application layer (ReleaseEscrow)
  // and adapter bookkeeping rely on.

  it('initializes releasedAmount to zero in the same currency as amount', () => {
    const e = base();
    expect(e.releasedAmount.amountMinor).toBe(0n);
    expect(e.releasedAmount.currency).toBe(e.amount.currency);
  });

  it('allows accumulating partial releases on releasedAmount without leaving held', () => {
    // Simulates what ReleaseEscrow does on each tranche: it accumulates the
    // released total on the entity while the gateway keeps reporting `held`.
    // Only a full-balance / final-tranche call advances the status.
    const e = base();
    const firstTranche = Money.of(75_000n, 'CRC');
    const partiallyReleased = { ...e, releasedAmount: e.releasedAmount.add(firstTranche) };
    expect(partiallyReleased.status).toBe('held');
    expect(partiallyReleased.releasedAmount.amountMinor).toBe(75_000n);

    const secondTranche = Money.of(75_000n, 'CRC');
    const fullyAccumulated = {
      ...partiallyReleased,
      releasedAmount: partiallyReleased.releasedAmount.add(secondTranche),
    };
    expect(fullyAccumulated.releasedAmount.amountMinor).toBe(e.amount.amountMinor);

    const finalized = transitionEscrow(fullyAccumulated, { to: 'released' });
    expect(finalized.status).toBe('released');
  });

  it('defaults to no milestone condition and zero platform fee when the contract fields are omitted', () => {
    const e = createEscrow({
      id: 'esc_bare',
      consumer: 'marketplace-core',
      payerReference: 'buyer-1',
      payeeReference: 'seller-1',
      amount: usd(10_000n),
      idempotencyKey: key,
    });
    expect(e.milestoneCondition).toBeNull();
    expect(e.platformFeeMinor).toBe(0n);
    expect(e.platformFeeDestination).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Payout
// ---------------------------------------------------------------------------

describe('Payout state machine', () => {
  const base = () =>
    createPayout({
      id: 'po_1',
      consumer: 'aduanext-api',
      beneficiaryReference: 'broker-7',
      amount: usd(10_000n),
      idempotencyKey: key,
    });

  it.each([
    ['pending', 'paid', true],
    ['pending', 'failed', true],
    ['paid', 'failed', false],
    ['failed', 'paid', false],
  ] as const)('canTransition(%s → %s) = %s', (from, to, expected) => {
    expect(canTransitionPayout(from, to)).toBe(expected);
  });

  it('advances pending → paid', () => {
    const p = transitionPayout(base(), 'paid');
    expect(p.status).toBe('paid');
  });

  it('rejects paid → pending', () => {
    const p = transitionPayout(base(), 'paid');
    expect(() => transitionPayout(p, 'pending')).toThrowError(InvalidStateTransitionError);
  });
});

// ---------------------------------------------------------------------------
// Refund
// ---------------------------------------------------------------------------

describe('Refund state machine', () => {
  const base = () =>
    createRefund({
      id: 'ref_1',
      intentId: 'pi_1',
      amount: usd(500n),
      reason: 'customer request',
      idempotencyKey: key,
    });

  it.each([
    ['requested', 'succeeded', true],
    ['requested', 'failed', true],
    ['succeeded', 'failed', false],
    ['failed', 'succeeded', false],
  ] as const)('canTransition(%s → %s) = %s', (from, to, expected) => {
    expect(canTransitionRefund(from, to)).toBe(expected);
  });

  it('throws on illegal refund transitions', () => {
    const r = transitionRefund(base(), 'failed');
    expect(() => transitionRefund(r, 'succeeded')).toThrowError(
      InvalidStateTransitionError,
    );
  });
});

// ---------------------------------------------------------------------------
// Dispute
// ---------------------------------------------------------------------------

describe('Dispute state machine', () => {
  const base = () =>
    createDispute({
      id: 'dp_1',
      intentId: 'pi_1',
      reason: 'duplicate charge',
      idempotencyKey: key,
    });

  it('submits evidence then wins', () => {
    let d = base();
    d = submitDisputeEvidence(d, ['receipt.pdf', 'chat-log.html']);
    expect(d.status).toBe('evidence_submitted');
    expect(d.evidence).toHaveLength(2);
    d = transitionDispute(d, 'won');
    expect(d.status).toBe('won');
  });

  it('can withdraw from opened', () => {
    let d = base();
    d = transitionDispute(d, 'withdrawn');
    expect(d.status).toBe('withdrawn');
  });

  it.each([
    ['opened', 'evidence_submitted', true],
    ['opened', 'withdrawn', true],
    ['opened', 'won', false],
    ['evidence_submitted', 'won', true],
    ['evidence_submitted', 'lost', true],
    ['won', 'lost', false],
    ['lost', 'won', false],
    ['withdrawn', 'opened', false],
  ] as const)('canTransition(%s → %s) = %s', (from, to, expected) => {
    expect(canTransitionDispute(from, to)).toBe(expected);
  });

  it('rejects submitting evidence from a terminal state', () => {
    let d = base();
    d = transitionDispute(d, 'withdrawn');
    expect(() => submitDisputeEvidence(d, ['too-late.pdf'])).toThrowError(
      InvalidStateTransitionError,
    );
  });
});

// ---------------------------------------------------------------------------
// Donation
// ---------------------------------------------------------------------------

describe('Donation state machine', () => {
  const base = () =>
    createDonation({
      id: 'don_1',
      consumer: 'altrupets',
      donorReference: 'donor-42',
      campaignId: 'cause-save-the-dogs',
      kind: 'one_time',
      amount: usd(2500n),
      idempotencyKey: key,
    });

  it('carries campaign metadata', () => {
    const d = base();
    expect(d.campaignId).toBe('cause-save-the-dogs');
    expect(d.kind).toBe('one_time');
  });

  it.each([
    ['intent', 'pending', true],
    ['pending', 'succeeded', true],
    ['succeeded', 'refunded', true],
    ['intent', 'succeeded', false],
    ['failed', 'pending', false],
    ['refunded', 'pending', false],
  ] as const)('canTransition(%s → %s) = %s', (from, to, expected) => {
    expect(canTransitionDonation(from, to)).toBe(expected);
  });

  it('advances a recurring donation through the lifecycle', () => {
    let d = createDonation({
      id: 'don_2',
      consumer: 'altrupets',
      donorReference: 'donor-7',
      campaignId: 'cause-forever-home',
      kind: 'recurring',
      amount: usd(500n),
      idempotencyKey: key,
    });
    d = transitionDonation(d, 'pending');
    d = transitionDonation(d, 'succeeded');
    d = transitionDonation(d, 'refunded');
    expect(d.status).toBe('refunded');
  });

  it('throws on illegal donation transitions', () => {
    const d = base();
    expect(() => transitionDonation(d, 'refunded')).toThrowError(
      InvalidStateTransitionError,
    );
  });
});
