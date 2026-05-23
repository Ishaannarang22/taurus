import { test } from "node:test";
import assert from "node:assert/strict";
import { planSingleOrder } from "./order-math";

test("buy by notional computes fractional shares and cash out", () => {
  const r = planSingleOrder({
    side: "buy",
    price: 100,
    notional: 250,
    cashBalance: 1000,
    positionQty: 0,
    positionAvg: 0,
  });
  assert.equal(r.ok, true);
  assert.equal(r.qty, 2.5);
  assert.equal(r.cashAfter, 750);
  assert.equal(r.newPositionQty, 2.5);
  assert.equal(r.newPositionAvg, 100);
});

test("buy rejected when it exceeds cash", () => {
  const r = planSingleOrder({
    side: "buy",
    price: 100,
    quantity: 11,
    cashBalance: 1000,
    positionQty: 0,
    positionAvg: 0,
  });
  assert.equal(r.ok, false);
  assert.match(r.error!, /insufficient cash/);
});

test("buy averages into an existing position", () => {
  const r = planSingleOrder({
    side: "buy",
    price: 200,
    quantity: 1,
    cashBalance: 1000,
    positionQty: 1,
    positionAvg: 100,
  });
  assert.equal(r.ok, true);
  assert.equal(r.newPositionQty, 2);
  assert.equal(r.newPositionAvg, 150); // (1*100 + 1*200)/2
});

test("sell reduces position and adds proceeds to cash", () => {
  const r = planSingleOrder({
    side: "sell",
    price: 150,
    quantity: 1,
    cashBalance: 500,
    positionQty: 2,
    positionAvg: 100,
  });
  assert.equal(r.ok, true);
  assert.equal(r.cashAfter, 650);
  assert.equal(r.newPositionQty, 1);
  assert.equal(r.newPositionAvg, 100); // unchanged when reducing
});

test("sell flat resets average to zero", () => {
  const r = planSingleOrder({
    side: "sell",
    price: 150,
    quantity: 2,
    cashBalance: 0,
    positionQty: 2,
    positionAvg: 100,
  });
  assert.equal(r.ok, true);
  assert.equal(r.newPositionQty, 0);
  assert.equal(r.newPositionAvg, 0);
});

test("sell more than held is rejected (no shorting)", () => {
  const r = planSingleOrder({
    side: "sell",
    price: 150,
    quantity: 5,
    cashBalance: 0,
    positionQty: 2,
    positionAvg: 100,
  });
  assert.equal(r.ok, false);
  assert.match(r.error!, /no shorting/);
});

test("rejects missing quantity and notional", () => {
  const r = planSingleOrder({
    side: "buy",
    price: 100,
    cashBalance: 1000,
    positionQty: 0,
    positionAvg: 0,
  });
  assert.equal(r.ok, false);
});

test("rejects both quantity and notional", () => {
  const r = planSingleOrder({
    side: "buy",
    price: 100,
    quantity: 1,
    notional: 100,
    cashBalance: 1000,
    positionQty: 0,
    positionAvg: 0,
  });
  assert.equal(r.ok, false);
});

test("rejects non-positive price", () => {
  const r = planSingleOrder({
    side: "buy",
    price: 0,
    quantity: 1,
    cashBalance: 1000,
    positionQty: 0,
    positionAvg: 0,
  });
  assert.equal(r.ok, false);
});
