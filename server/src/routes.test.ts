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
