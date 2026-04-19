// =============================================================================
// Stripe SubscriptionPort implementation.
// -----------------------------------------------------------------------------
// Implements create / switch / cancel / prorate against Stripe Billing.
//
// Notes:
//   - `create` treats `planId` as a Stripe `price_*` id. The port does not
//     expose `customerId` as a first-class field because Stripe's customer
//     model is gateway-specific; we require callers to pre-create the
//     customer and pass its id in `metadata.customer_id`. The adapter reads
//     that key and fails with GATEWAY_INVALID_REQUEST if missing.
//
//   - `switch` maps the port's three-value `prorationBehavior` directly onto
//     Stripe's proration modes with identical names.
//
//   - `cancel` honours `atPeriodEnd`. When true, Stripe keeps billing until
//     the current period end; we read `current_period_end` and surface it as
//     `effectiveAt`. When false, Stripe cancels immediately; `effectiveAt`
//     is the `canceled_at` timestamp (or `now` as a fallback if Stripe
//     omitted it on synchronous cancel).
//
//   - `prorate` uses `invoices.createPreview` with the proration preview
//     semantics. Returns two Money values on the domain's `Money` shape. We
//     reconstruct them via `Money.of` to keep the domain boundary honest.
// =============================================================================

import {
  Money,
  type CancelSubscriptionInput,
  type CancelSubscriptionResult,
  type CreateSubscriptionPortInput,
  type CreateSubscriptionPortResult,
  type GatewayName,
  type ProrateInput,
  type ProrateResult,
  type SubscriptionPort,
  type SwitchSubscriptionInput,
  type SwitchSubscriptionResult,
} from '../../../../domain/index.js';
import type { StripeClient, StripeRequestOptions, StripeSubscription } from './client.js';
import { StripeGatewayError, mapStripeError } from './errors.js';
import { mapSubscriptionStatus, stripeRef, toStripeMetadata } from './mappers.js';

export interface StripeSubscriptionAdapterDeps {
  readonly client: StripeClient;
}

/** Reserved metadata key used to pass the Stripe customer id to `create`. */
export const STRIPE_CUSTOMER_ID_METADATA_KEY = 'customer_id' as const;

export class StripeSubscriptionAdapter implements SubscriptionPort {
  readonly gateway: GatewayName = 'stripe';

  constructor(private readonly deps: StripeSubscriptionAdapterDeps) {}

  async create(
    input: CreateSubscriptionPortInput,
  ): Promise<CreateSubscriptionPortResult> {
    const customerId = input.metadata[STRIPE_CUSTOMER_ID_METADATA_KEY];
    if (customerId === undefined || customerId.length === 0) {
      throw new StripeGatewayError(
        'GATEWAY_INVALID_REQUEST',
        `Stripe subscription create requires metadata.${STRIPE_CUSTOMER_ID_METADATA_KEY}`,
      );
    }
    const requestOptions: StripeRequestOptions = {
      idempotencyKey: input.idempotencyKey,
    };
    try {
      const sub = await this.deps.client.subscriptions.create(
        {
          customer: customerId,
          items: [{ price: input.planId }],
          metadata: toStripeMetadata(input.metadata, {
            consumer: input.consumer,
            customer_reference: input.customerReference,
          }),
        },
        requestOptions,
      );
      return {
        gatewayRef: stripeRef(sub.id),
        status: mapSubscriptionStatus(sub.status),
      };
    } catch (err) {
      throw mapStripeError(err);
    }
  }

  async switch(input: SwitchSubscriptionInput): Promise<SwitchSubscriptionResult> {
    const requestOptions: StripeRequestOptions = {
      idempotencyKey: input.idempotencyKey,
    };
    try {
      const sub = await this.fetchSubscription(input.gatewayRef.externalId);
      const firstItem = sub.items?.data?.[0];
      if (firstItem === undefined) {
        throw new StripeGatewayError(
          'GATEWAY_INVALID_REQUEST',
          `Stripe subscription ${sub.id} has no items to switch.`,
        );
      }
      const updated = await this.deps.client.subscriptions.update(
        sub.id,
        {
          items: [{ id: firstItem.id, price: input.newPlanId }],
          proration_behavior: input.prorationBehavior,
        },
        requestOptions,
      );
      return {
        gatewayRef: stripeRef(updated.id),
        status: mapSubscriptionStatus(updated.status),
      };
    } catch (err) {
      throw mapStripeError(err);
    }
  }

  async cancel(input: CancelSubscriptionInput): Promise<CancelSubscriptionResult> {
    const requestOptions: StripeRequestOptions = {
      idempotencyKey: input.idempotencyKey,
    };
    try {
      const subId = input.gatewayRef.externalId;
      let sub: StripeSubscription;
      let effectiveAt: Date;
      if (input.atPeriodEnd) {
        sub = await this.deps.client.subscriptions.update(
          subId,
          {
            cancel_at_period_end: true,
            ...(input.reason !== undefined
              ? { cancellation_details: { comment: input.reason } }
              : {}),
          },
          requestOptions,
        );
        // Read the Stripe item's current_period_end — the subscription-level
        // field has moved to the item level in recent API versions.
        const firstItem = sub.items?.data?.[0];
        const periodEnd = firstItem?.current_period_end;
        effectiveAt = periodEnd !== undefined
          ? new Date(periodEnd * 1000)
          : new Date();
      } else {
        sub = await this.deps.client.subscriptions.cancel(
          subId,
          {
            ...(input.reason !== undefined
              ? { cancellation_details: { comment: input.reason } }
              : {}),
          },
          requestOptions,
        );
        effectiveAt = sub.canceled_at !== null && sub.canceled_at !== undefined
          ? new Date(sub.canceled_at * 1000)
          : new Date();
      }
      return {
        gatewayRef: stripeRef(sub.id),
        status: mapSubscriptionStatus(sub.status),
        effectiveAt,
      };
    } catch (err) {
      throw mapStripeError(err);
    }
  }

  async prorate(input: ProrateInput): Promise<ProrateResult> {
    try {
      const sub = await this.fetchSubscription(input.gatewayRef.externalId);
      const firstItem = sub.items?.data?.[0];
      if (firstItem === undefined) {
        throw new StripeGatewayError(
          'GATEWAY_INVALID_REQUEST',
          `Stripe subscription ${sub.id} has no items to prorate.`,
        );
      }
      const preview = await this.deps.client.invoices.createPreview({
        subscription: sub.id,
        subscription_details: {
          items: [{ id: firstItem.id, price: input.newPlanId }],
          proration_behavior: 'create_prorations',
        },
      });
      const currency = preview.currency.toUpperCase();
      // Stripe returns `amount_due` for the prorated portion being billed now
      // and `amount_remaining` for the next cycle. `amount_due` can be
      // negative for downgrades (credit); we clamp to zero because the
      // domain Money value object requires non-negative amounts.
      const proratedMinor = preview.amount_due < 0 ? 0n : BigInt(preview.amount_due);
      const nextMinor = BigInt(preview.amount_remaining);
      return {
        proratedAmount: Money.of(proratedMinor, currency),
        nextCycleAmount: Money.of(nextMinor, currency),
      };
    } catch (err) {
      throw mapStripeError(err);
    }
  }

  private async fetchSubscription(subscriptionId: string): Promise<StripeSubscription> {
    return this.deps.client.subscriptions.retrieve(subscriptionId);
  }
}
