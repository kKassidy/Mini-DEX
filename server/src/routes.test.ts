import { describe, expect, it, vi } from "vitest";
import { OrderBook } from "./engine/orderbook.js";
import { parseFixed as F } from "./fixed.js";
import { Ledger } from "./ledger.js";
import { createRoutes, type RoutesDeps } from "./routes.js";

function setup() {
  const ledger = new Ledger();
  const book = new OrderBook();
  const ws = { broadcast: vi.fn(), sendBalance: vi.fn() };
  const chain: RoutesDeps["chain"] = {
    offline: true,
    signerAddress: "0x0",
    tokenAddress: () => "0x0",
    watchDeposits: vi.fn(),
    signWithdraw: vi.fn(),
  };
  const routes = createRoutes({
    ledger, book, ws, chain,
    bearer: async (c, next) => { c.set("address", "0xabc"); await next(); },
    config: { chainId: 31337, wsUrl: "", vault: "", usdc: "", wavax: "" },
  });
  for (const owner of ["0xabc", "other"]) {
    ledger.credit(owner, "USDC", F("1000"));
    ledger.credit(owner, "WAVAX", F("10"));
  }
  return { ledger, book, ws, ...routes };
}

describe.each(["buy", "sell"] as const)("self-trade accounting: %s taker", (side) => {
  it.each(["limit", "market"] as const)("%s rejection restores only the incoming freeze", async (type) => {
    const { ledger, book, ws, app, placeOrder, cancelOrder } = setup();
    const opposite = side === "buy" ? "sell" : "buy";
    const first = placeOrder("other", {
      side: opposite, type: "limit", price: F(side === "buy" ? "99" : "101"), qty: F("1"),
    }).order;
    const own = placeOrder("0xAbC", { side: opposite, type: "limit", price: F("100"), qty: F("2") }).order;
    // Also keep an unrelated lock in the same asset as the incoming freeze.
    const unrelated = placeOrder("0xabc", {
      side, type: "limit", price: F(side === "buy" ? "90" : "110"), qty: F("1"),
    }).order;
    const balances = structuredClone([ledger.get("0xabc"), ledger.get("other")]);
    const orders = structuredClone([first, own, unrelated]);
    const depth = book.snapshot();
    const lock = vi.spyOn(ledger, "lock");
    const unlock = vi.spyOn(ledger, "unlock");
    const transfer = vi.spyOn(ledger, "transferLocked");
    ws.broadcast.mockClear();
    ws.sendBalance.mockClear();

    const response = await app.request("/orders", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ side, type, price: "100", qty: "2" }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Self-trade is not allowed" });
    const asset = side === "buy" ? "USDC" : "WAVAX";
    const frozen = side === "sell" ? F("2") : type === "limit" ? F("200") : balances[0].USDC.available;
    expect(lock).toHaveBeenCalledTimes(1);
    expect(lock).toHaveBeenCalledWith("0xabc", asset, frozen);
    expect(unlock).toHaveBeenCalledTimes(1);
    expect(unlock).toHaveBeenCalledWith("0xabc", asset, frozen);
    expect([ledger.get("0xabc"), ledger.get("other")]).toEqual(balances);
    expect(book.snapshot()).toEqual(depth);
    expect([book.get(first.id), book.get(own.id), book.get(unrelated.id)]).toEqual(orders);
    expect(transfer).not.toHaveBeenCalled();
    expect(ws.broadcast).not.toHaveBeenCalled();
    expect(ws.sendBalance).not.toHaveBeenCalled();
    expect(await (await app.request("/trades")).json()).toEqual([]);

    // Existing per-order lock records still release exactly their original funds.
    cancelOrder("0xAbC", own.id);
    cancelOrder("0xabc", unrelated.id);
    cancelOrder("other", first.id);
    for (const owner of ["0xabc", "other"]) {
      expect(ledger.get(owner)).toEqual({
        USDC: { available: F("1000"), locked: 0n },
        WAVAX: { available: F("10"), locked: 0n },
      });
    }
    expect(book.snapshot()).toEqual({ bids: [], asks: [] });
  });
});

async function submit(app: ReturnType<typeof setup>["app"], body: Record<string, unknown>) {
  return app.request("/orders", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}

describe.each(["buy", "sell"] as const)("TIF accounting: %s", (side) => {
  const opposite = side === "buy" ? "sell" : "buy";
  const makerPrice = side === "buy" ? "90" : "110";
  const outsidePrice = side === "buy" ? "110" : "90";
  const unrelatedPrice = side === "buy" ? "80" : "120";

  it.each([
    ["IOC", "3", "3"], ["IOC", "1", "1"], ["IOC", "0", "0"],
    ["FOK", "3", "3"], ["FOK", "1", "0"],
  ] as const)("%s with %s eligible quantity settles %s and refunds exactly", async (timeInForce, liquidity, filled) => {
    const { app, ledger, book, placeOrder, cancelOrder, ws } = setup();
    const unrelated = placeOrder("0xabc", { side, type: "limit", price: F(unrelatedPrice), qty: F("1") }).order;
    if (liquidity !== "0") placeOrder("other", { side: opposite, type: "limit", price: F(makerPrice), qty: F(liquidity) });
    const outside = placeOrder("other", { side: opposite, type: "limit", price: F(outsidePrice), qty: F("4") }).order;
    const before = structuredClone([ledger.get("0xabc"), ledger.get("other")]);
    const orders = structuredClone([...book.ordersOf("0xabc"), ...book.ordersOf("other")]);
    const depth = book.snapshot();
    const unlock = vi.spyOn(ledger, "unlock");
    const transfer = vi.spyOn(ledger, "transferLocked");
    ws.broadcast.mockClear();
    const response = await submit(app, { side, type: "limit", price: "100", qty: "3", timeInForce });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.order.timeInForce).toBe(timeInForce);
    expect(result.order.remaining).toBe(String(3 - Number(filled)));
    expect(result.fills.reduce((sum: bigint, f: { qty: string }) => sum + F(f.qty), 0n)).toBe(F(filled));
    expect(book.get(result.order.id)).toBeUndefined();
    expect(book.get(outside.id)?.remaining).toBe(F("4"));
    const base = F(filled), quote = F(String(Number(filled) * Number(makerPrice)));
    const owner = ledger.get("0xabc");
    expect(owner.USDC.available).toBe(before[0].USDC.available + (side === "buy" ? -quote : quote));
    expect(owner.WAVAX.available).toBe(before[0].WAVAX.available + (side === "sell" ? -base : base));
    expect(owner.USDC.locked).toBe(before[0].USDC.locked);
    expect(owner.WAVAX.locked).toBe(before[0].WAVAX.locked);
    const refund = side === "buy" ? F("300") - quote : F("3") - base;
    if (refund > 0n) expect(unlock).toHaveBeenCalledWith("0xabc", side === "buy" ? "USDC" : "WAVAX", refund);
    for (const asset of ["USDC", "WAVAX"] as const) {
      const total = (balances: typeof before) => balances.reduce((sum, b) => sum + b[asset].available + b[asset].locked, 0n);
      expect(total([owner, ledger.get("other")])).toBe(total(before));
    }
    if (filled === "0") {
      expect([owner, ledger.get("other")]).toEqual(before);
      expect(book.snapshot()).toEqual(depth);
      expect([...book.ordersOf("0xabc"), ...book.ordersOf("other")]).toEqual(orders);
      expect(transfer).not.toHaveBeenCalled();
      expect(await (await app.request("/trades")).json()).toEqual([]);
      expect(ws.broadcast.mock.calls.some(([type]) => type === "trade")).toBe(false);
    }
    cancelOrder("0xabc", unrelated.id);
    expect(owner.USDC.locked).toBe(0n);
    expect(owner.WAVAX.locked).toBe(0n);
    expect(owner.USDC.available).toBe(F("1000") + (side === "buy" ? -quote : quote));
    expect(owner.WAVAX.available).toBe(F("10") + (side === "sell" ? -base : base));
  });

  it.each(["IOC", "FOK"] as const)("%s self-trade rejection refunds only the incoming reservation", async (timeInForce) => {
    const { app, ledger, book, placeOrder, cancelOrder, ws } = setup();
    const first = placeOrder("other", { side: opposite, type: "limit", price: F(makerPrice), qty: F("1") }).order;
    const own = placeOrder("0xAbC", { side: opposite, type: "limit", price: F("100"), qty: F("1") }).order;
    const unrelated = placeOrder("0xabc", { side, type: "limit", price: F(unrelatedPrice), qty: F("1") }).order;
    const before = structuredClone([ledger.get("0xabc"), ledger.get("other")]);
    const orders = structuredClone([first, own, unrelated]);
    const transfer = vi.spyOn(ledger, "transferLocked");
    ws.broadcast.mockClear();
    const response = await submit(app, { side, type: "limit", price: "100", qty: "3", timeInForce });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Self-trade is not allowed" });
    expect([ledger.get("0xabc"), ledger.get("other")]).toEqual(before);
    expect([book.get(first.id), book.get(own.id), book.get(unrelated.id)]).toEqual(orders);
    expect(transfer).not.toHaveBeenCalled();
    expect(ws.broadcast).not.toHaveBeenCalled();
    cancelOrder("0xAbC", own.id);
    cancelOrder("0xabc", unrelated.id);
    expect(ledger.get("0xabc")).toEqual({ USDC: { available: F("1000"), locked: 0n }, WAVAX: { available: F("10"), locked: 0n } });
  });

  it.each([undefined, "GTC"] as const)("limit %s retains a funded GTC remainder", async (timeInForce) => {
    const { app, ledger, book, placeOrder } = setup();
    placeOrder("other", { side: opposite, type: "limit", price: F(makerPrice), qty: F("1") });
    const response = await submit(app, { side, type: "limit", price: "100", qty: "3", timeInForce });
    expect(response.status).toBe(200);
    const { order } = await response.json();
    expect(order.timeInForce).toBe("GTC");
    expect(book.get(order.id)?.remaining).toBe(F("2"));
    expect(ledger.get("0xabc")[side === "buy" ? "USDC" : "WAVAX"].locked).toBe(F(side === "buy" ? "200" : "2"));
    const listed = await (await app.request("/orders")).json();
    expect(listed[0].timeInForce).toBe("GTC");
  });

  it.each([undefined, "IOC"] as const)("market %s preserves partial-fill non-resting behavior", async (timeInForce) => {
    const { app, ledger, book, placeOrder } = setup();
    placeOrder("other", { side: opposite, type: "limit", price: F(makerPrice), qty: F("1") });
    const response = await submit(app, { side, type: "market", qty: "3", timeInForce });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.order.timeInForce).toBe("IOC");
    expect(result.order.remaining).toBe("2");
    expect(result.fills).toHaveLength(1);
    expect(book.ordersOf("0xabc")).toEqual([]);
    expect(ledger.get("0xabc").USDC.locked).toBe(0n);
    expect(ledger.get("0xabc").WAVAX.locked).toBe(0n);
    expect(ledger.get("0xabc").USDC.available).toBe(F(side === "buy" ? "910" : "1110"));
    expect(ledger.get("0xabc").WAVAX.available).toBe(F(side === "buy" ? "11" : "9"));
  });
});

it.each([
  ["market", "GTC"], ["market", "FOK"], ["limit", "DAY"], ["limit", "ioc"],
  ["limit", ""], ["limit", null], ["limit", 0], ["limit", false], ["limit", {}], ["limit", ["IOC"]],
])("rejects %s with invalid TIF %j before locking", async (type, timeInForce) => {
  const { app, ledger, book } = setup();
  const lock = vi.spyOn(ledger, "lock");
  const response = await submit(app, { side: "buy", type, price: "100", qty: "1", timeInForce });
  expect(response.status).toBe(400);
  expect(lock).not.toHaveBeenCalled();
  expect(book.snapshot()).toEqual({ bids: [], asks: [] });
});

it.each(["GTC", "FOK"] as const)("internal market %s also rejects before locking", (timeInForce) => {
  const { ledger, placeOrder } = setup();
  const lock = vi.spyOn(ledger, "lock");
  expect(() => placeOrder("0xabc", { side: "buy", type: "market", price: 0n, qty: F("1"), timeInForce })).toThrow("Market orders only support IOC");
  expect(lock).not.toHaveBeenCalled();
});
