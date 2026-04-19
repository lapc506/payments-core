// =============================================================================
// OnvoPay SubscriptionPort implementation
// -----------------------------------------------------------------------------
// Implements `SubscriptionPort` against OnvoPay's recurring-charges API
// (Cargos Recurrentes).
//
// Endpoint assumptions (TODO: verify against
// https://docs.onvopay.com/#tag/Cargos-recurrentes):
//   - POST    /v1/subscriptions                      create subscription
//   - PATCH   /v1/subscriptions/:id                  switch plan / prorate
//   - DELETE  /v1/subscriptions/:id                  cancel (immediate)
//   - POST    /v1/subscriptions/:id/cancel           cancel-at-period-end flag
//
// `prorate` is a best-effort computation: OnvoPay may not expose a
// dedicated proration preview endpoint. If not available, the method falls
// back to returning the current + new plan amounts as the next-cycle figure
// and documents the limitation in docs/content/docs/adapters/onvopay.md.
// =============================================================================

import type {
  CancelSubscriptionInput,
  CancelSubscriptionResult,
  CreateSubscriptionPortInput,
  CreateSubscriptionPortResult,
  ProrateInput,
  ProrateResult,
  SubscriptionPort,
  SwitchSubscriptionInput,
  SwitchSubscriptionResult,
} from '../../../../domain/ports/index.js';
import { DomainError } from '../../../../domain/errors.js';
import { Money } from '../../../../domain/value_objects/money.js';

import { mapOnvoPayError } from './errors.js';
import {
  toGatewayRef,
  toSubscriptionStatus,
  type OnvoPaySubscription,
} from './mappers.js';
import type { OnvoPayHttpClient } from './client.js';

const SUBSCRIPTIONS_PATH = '/v1/subscriptions';

export class OnvoPaySubscriptionGateway implements SubscriptionPort {
  readonly gateway = 'onvopay' as const;

  constructor(private readonly http: OnvoPayHttpClient) {}

  async create(input: CreateSubscriptionPortInput): Promise<CreateSubscriptionPortResult> {
    try {
      const body = {
        customer: input.customerReference,
        plan: input.planId,
        metadata: { ...input.metadata, consumer: input.consumer },
      };
      const sub = await this.http.request<OnvoPaySubscription>({
        method: 'POST',
        path: SUBSCRIPTIONS_PATH,
        idempotencyKey: input.idempotencyKey,
        body,
      });
      return {
        gatewayRef: toGatewayRef(sub.id),
        status: toSubscriptionStatus(sub.status),
      };
    } catch (err) {
      throw mapOnvoPayError(err);
    }
  }

  async switch(input: SwitchSubscriptionInput): Promise<SwitchSubscriptionResult> {
    try {
      const body = {
        plan: input.newPlanId,
        // TODO: verify the proration-behavior enum accepted by
        // https://docs.onvopay.com/#tag/Cargos-recurrentes. The Stripe vocabulary
        // ('create_prorations', 'none', 'always_invoice') is passed through
        // unchanged; OnvoPay may accept a different enum.
        proration_behavior: input.prorationBehavior,
      };
      const sub = await this.http.request<OnvoPaySubscription>({
        method: 'PATCH',
        path: `${SUBSCRIPTIONS_PATH}/${encodeURIComponent(input.gatewayRef.externalId)}`,
        idempotencyKey: input.idempotencyKey,
        body,
      });
      return {
        gatewayRef: toGatewayRef(sub.id),
        status: toSubscriptionStatus(sub.status),
      };
    } catch (err) {
      throw mapOnvoPayError(err);
    }
  }

  async cancel(input: CancelSubscriptionInput): Promise<CancelSubscriptionResult> {
    try {
      // Immediate cancellation: DELETE /subscriptions/:id. Cancel-at-period-end
      // is modeled as POST /subscriptions/:id/cancel with a body flag because
      // DELETE bodies are inconsistently handled across HTTP clients.
      const effectiveAt = new Date();
      if (input.atPeriodEnd) {
        const sub = await this.http.request<OnvoPaySubscription>({
          method: 'POST',
          path: `${SUBSCRIPTIONS_PATH}/${encodeURIComponent(input.gatewayRef.externalId)}/cancel`,
          idempotencyKey: input.idempotencyKey,
          body: { at_period_end: true, reason: input.reason },
        });
        return {
          gatewayRef: toGatewayRef(sub.id),
          status: toSubscriptionStatus(sub.status),
          // TODO: verify whether OnvoPay returns the effective-at timestamp in
          // the subscription payload (e.g. `cancel_at`). For now we stamp the
          // adapter-side clock as a conservative lower bound.
          effectiveAt,
        };
      }
      const sub = await this.http.request<OnvoPaySubscription>({
        method: 'DELETE',
        path: `${SUBSCRIPTIONS_PATH}/${encodeURIComponent(input.gatewayRef.externalId)}`,
        idempotencyKey: input.idempotencyKey,
      });
      return {
        gatewayRef: toGatewayRef(sub.id),
        status: toSubscriptionStatus(sub.status),
        effectiveAt,
      };
    } catch (err) {
      throw mapOnvoPayError(err);
    }
  }

  async prorate(_input: ProrateInput): Promise<ProrateResult> {
    // TODO: verify against https://docs.onvopay.com/#tag/Cargos-recurrentes —
    // OnvoPay may expose `GET /subscriptions/:id/preview?plan=...` (or a
    // similarly-named endpoint) that returns the prorated delta plus the
    // next-cycle invoice amount. Until verified, this method throws rather
    // than return a fabricated figure, so use-case-layer callers see an
    // explicit capability gap instead of silent wrong numbers.
    //
    // When implementing: call the preview endpoint, parse the two Money
    // amounts via Money.of(BigInt(amount), currency), and return. Keep the
    // bigint / JSON-number boundary tight: the parse path is the only place
    // the adapter converts OnvoPay JSON numbers back into bigints.
    //
    // Referencing Money here keeps the domain import in the source graph so
    // the future implementation can consume the type without additional imports.
    void Money;
    throw new DomainError(
      'ADAPTER_ONVOPAY_NOT_IMPLEMENTED',
      'prorate is not implemented for OnvoPay; see onvopay-adapter-p0 follow-ups.',
    );
  }
}
