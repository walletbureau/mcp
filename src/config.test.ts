/**
 * Payment-mode selection and environment parsing (041 §3). The mode drives both the API
 * route and the price text in the tool description, so a mistake here is the costliest.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadConfig } from './config.ts';

const KEY = 'atk_0123456789abcdef';
const PRIVATE_KEY = `0x${'a'.repeat(64)}`;

describe('loadConfig', () => {
  it('runs in demo mode against the production domain when nothing is set', () => {
    const config = loadConfig({});
    assert.equal(config.mode, 'demo');
    assert.equal(config.API_BASE_URL, 'https://walletbureau.com');
    assert.equal(config.REQUEST_TIMEOUT_MS, 5_000);
    assert.equal(config.PAYMENT_TIMEOUT_MS, 60_000);
    assert.equal(config.X402_MAX_PRICE_USD, 0.1);
  });

  it('an API key enables api_key mode', () => {
    assert.equal(loadConfig({ WALLETBUREAU_API_KEY: KEY }).mode, 'api_key');
  });

  it('a private key enables wallet mode', () => {
    assert.equal(loadConfig({ X402_PRIVATE_KEY: PRIVATE_KEY }).mode, 'wallet');
  });

  it('with both, the key pays: the balance is prepaid, no extra transaction needed', () => {
    assert.equal(loadConfig({ WALLETBUREAU_API_KEY: KEY, X402_PRIVATE_KEY: PRIVATE_KEY }).mode, 'api_key');
  });

  it('a blank variable means "not set", not "set to empty"', () => {
    const config = loadConfig({ WALLETBUREAU_API_KEY: '', X402_PRIVATE_KEY: '   ' });
    assert.equal(config.mode, 'demo');
  });

  it('a trailing slash in the base URL is trimmed: otherwise it becomes //v1/score', () => {
    assert.equal(loadConfig({ API_BASE_URL: 'http://127.0.0.1:3000/' }).API_BASE_URL, 'http://127.0.0.1:3000');
  });

  it('a garbage key or private key fails startup with a clear message', () => {
    assert.throws(() => loadConfig({ WALLETBUREAU_API_KEY: 'sk_live_nope' }), /WALLETBUREAU_API_KEY/);
    assert.throws(() => loadConfig({ X402_PRIVATE_KEY: '0xdead' }), /X402_PRIVATE_KEY/);
    assert.throws(() => loadConfig({ API_BASE_URL: 'walletbureau.com' }), /API_BASE_URL/);
    assert.throws(() => loadConfig({ X402_MAX_PRICE_USD: '-1' }), /X402_MAX_PRICE_USD/);
  });
});
