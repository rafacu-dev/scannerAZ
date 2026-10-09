import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyAmazonSale } from './salesStatus.js';

test('only Amazon pending states are pending payment confirmation', () => {
  for (const status of ['PENDING', ' pending_availability ']) {
    assert.equal(classifyAmazonSale(status), 'pending');
  }
});

test('confirmed purchases count as sales before label printing or pickup', () => {
  for (const status of ['UNSHIPPED', 'SHIPPING', 'PARTIALLY_SHIPPED', 'SHIPPED', 'INVOICE_UNCONFIRMED']) {
    assert.equal(classifyAmazonSale(status), 'confirmed');
  }
});

test('canceled and missing states cannot inflate pending or confirmed orders', () => {
  assert.equal(classifyAmazonSale('CANCELED'), 'canceled');
  assert.equal(classifyAmazonSale('UNFULFILLABLE'), 'canceled');
  assert.equal(classifyAmazonSale(null), 'unknown');
  assert.equal(classifyAmazonSale('unexpected'), 'unknown');
});
