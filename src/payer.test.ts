/**
 * Spending cap. The remote server names the price, so the check must live in code next
 * to the payment signature, not in the tool description for the model (x402 guidance).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PaymentRequirements } from '@x402/core/types';
import { loadConfig } from './config.ts';
import { createPayer, createSpendCapPolicy } from './payer.ts';

function requirement(amount: string): PaymentRequirements {
  return {
    scheme: 'exact',
    network: 'eip155:8453',
    asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    amount,
    payTo: '0x2222222222222222222222222222222222222222',
    maxTimeoutSeconds: 60,
    extra: {},
  };
}

describe('createSpendCapPolicy', () => {
  it('keeps a price at the cap and cuts everything above it', () => {
    const policy = createSpendCapPolicy(0.1);
    const kept = policy(2, [requirement('50000'), requirement('100000'), requirement('100001')]);
    assert.deepEqual(kept.map((r) => r.amount), ['50000', '100000']);
  });

  it('an empty requirements list means refusing to pay, not paying blindly', () => {
    const policy = createSpendCapPolicy(0.01);
    assert.deepEqual(policy(2, [requirement('50000')]), []);
  });

  it('rejects a non-decimal amount', () => {
    const policy = createSpendCapPolicy(1);
    assert.deepEqual(policy(2, [requirement('0x50000')]), []);
  });
});

describe('createPayer', () => {
  it('without a wallet returns the plain fetch and identifies nobody', () => {
    const payer = createPayer(loadConfig({}));
    assert.equal(payer.payerAddress, null);
    assert.equal(payer.fetchImpl, fetch);
  });

  it('with a private key installs the paying fetch and knows the payer address', () => {
    const payer = createPayer(loadConfig({ X402_PRIVATE_KEY: `0x${'a'.repeat(64)}` }));
    assert.match(payer.payerAddress ?? '', /^0x[0-9a-fA-F]{40}$/);
    assert.notEqual(payer.fetchImpl, fetch);
  });
});
