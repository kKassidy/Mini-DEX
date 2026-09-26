// 撮合引擎单元测试（vitest）。每个 case 对应一条撮合规则，先看测试再看实现更好懂。
import { describe, it, expect } from "vitest";
import { OrderBook, SelfTradeError, type Side, type OrderType } from "./orderbook.js";
import { parseFixed as F } from "../fixed.js";

let n = 0;
function order(owner: string, side: Side, type: OrderType, price: string, qty: string) {
  return { id: `o${++n}`, owner, side, type, price: type === "market" ? 0n : F(price), qty: F(qty) };
}
const limit = (owner: string, side: Side, price: string, qty: string) => order(owner, side, "limit", price, qty);
const market = (owner: string, side: Side, qty: string) => order(owner, side, "market", "0", qty);

describe("OrderBook", () => {
  it.each(["buy", "sell"] as const)("partial-fill FIFO: resting %s keeps its position", (side) => {
    const ob = new OrderBook();
    const opposite = side === "buy" ? "sell" : "buy";
    const first = ob.submit(limit("a", side, "100", "3")).resting!;
    const second = ob.submit(limit("b", side, "100", "2")).resting!;
    expect(ob.submit(market("t", opposite, "1")).fills.map(f => [f.makerOrderId, f.qty]))
      .toEqual([[first.id, F("1")]]);
    expect(first.remaining).toBe(F("2"));
    expect(ob.submit(market("t", opposite, "3")).fills.map(f => [f.makerOrderId, f.qty]))
      .toEqual([[first.id, F("2")], [second.id, F("1")]]);
    expect(ob.get(first.id)).toBeUndefined();
    expect(ob.get(second.id)?.remaining).toBe(F("1"));
  });

  describe.each(["buy", "sell"] as const)("self-trade: %s taker", (side) => {
    const opposite = side === "buy" ? "sell" : "buy";
    it.each(["limit", "market"] as const)("rejects %s when own maker is first", (type) => {
      const ob = new OrderBook();
      const own = ob.submit(limit("alice", opposite, "100", "2")).resting!;
      const before = structuredClone(own);
      expect(() => ob.submit(order("alice", side, type, "100", "1"))).toThrow(SelfTradeError);
      expect(ob.get(own.id)).toEqual(before);
      expect(ob.ordersOf("alice")).toEqual([before]);
    });

    it.each(["limit", "market"] as const)("rejects %s atomically after earlier third-party liquidity", (type) => {
      const ob = new OrderBook();
      const first = ob.submit(limit("other", opposite, side === "buy" ? "99" : "101", "1")).resting!;
      const own = ob.submit(limit("0xAbC", opposite, "100", "2")).resting!;
      const before = structuredClone([first, own]);
      const depth = ob.snapshot();
      const incoming = order("0xabc", side, type, "100", "2");
      expect(() => ob.submit(incoming)).toThrow(SelfTradeError);
      expect(ob.snapshot()).toEqual(depth);
      expect([ob.get(first.id), ob.get(own.id)]).toEqual(before);
      expect(ob.get(incoming.id)).toBeUndefined();
      const next = ob.submit(limit("other", opposite, "100", "1")).resting!;
      expect(next.seq).toBe(own.seq + 1);
    });

    it.each(["limit", "market"] as const)("allows %s satisfied before own same-price liquidity", (type) => {
      const ob = new OrderBook();
      const first = ob.submit(limit("other", opposite, "100", "2")).resting!;
      const own = ob.submit(limit("alice", opposite, "100", "1")).resting!;
      // Leave a partially filled maker ahead of the own order.
      ob.submit(market("third", side, "1"));
      const r = ob.submit(order("alice", side, type, "100", "1"));
      expect(r.fills.map(f => [f.makerOrderId, f.qty])).toEqual([[first.id, F("1")]]);
      expect(r.resting).toBeNull();
      expect(ob.get(own.id)?.remaining).toBe(F("1"));
    });

    it("allows own liquidity beyond the limit price", () => {
      const ob = new OrderBook();
      const own = ob.submit(limit("alice", opposite, side === "buy" ? "101" : "99", "1")).resting!;
      const r = ob.submit(limit("alice", side, "100", "1"));
      expect(r.fills).toEqual([]);
      expect(r.resting?.remaining).toBe(F("1"));
      expect(ob.get(own.id)?.remaining).toBe(F("1"));
    });
  });

  it("空簿：limit 单直接挂上", () => {
    const ob = new OrderBook();
    const r = ob.submit(limit("alice", "sell", "100", "1"));
    expect(r.fills).toHaveLength(0);
    expect(r.resting?.remaining).toBe(F("1"));
    expect(ob.bestAsk()).toBe(F("100"));
    expect(ob.bestBid()).toBeNull();
  });

  it("价格交叉：按 maker 价成交", () => {
    const ob = new OrderBook();
    ob.submit(limit("alice", "sell", "100", "1"));
    const r = ob.submit(limit("bob", "buy", "105", "1")); // bob 愿出 105，但按 alice 的 100 成交
    expect(r.fills).toHaveLength(1);
    expect(r.fills[0]!.price).toBe(F("100"));
    expect(r.fills[0]!.qty).toBe(F("1"));
    expect(r.fills[0]!.maker).toBe("alice");
    expect(r.fills[0]!.taker).toBe("bob");
    expect(r.resting).toBeNull();
    expect(ob.bestAsk()).toBeNull();
  });

  it("部分成交：剩余部分挂单", () => {
    const ob = new OrderBook();
    ob.submit(limit("alice", "sell", "100", "1"));
    const r = ob.submit(limit("bob", "buy", "100", "3"));
    expect(r.fills).toHaveLength(1);
    expect(r.fills[0]!.qty).toBe(F("1"));
    expect(r.resting?.remaining).toBe(F("2"));
    expect(ob.bestBid()).toBe(F("100"));
    expect(ob.snapshot(5).bids).toEqual([[F("100"), F("2")]]);
  });

  it("价格优先：更优价格先成交", () => {
    const ob = new OrderBook();
    ob.submit(limit("a", "sell", "102", "1"));
    ob.submit(limit("b", "sell", "100", "1")); // 更便宜，后挂但先成交
    const r = ob.submit(market("t", "buy", "1"));
    expect(r.fills).toHaveLength(1);
    expect(r.fills[0]!.maker).toBe("b");
    expect(r.fills[0]!.price).toBe(F("100"));
  });

  it("时间优先：同价 FIFO", () => {
    const ob = new OrderBook();
    const first = ob.submit(limit("a", "sell", "100", "1")).resting!;
    ob.submit(limit("b", "sell", "100", "1"));
    const r = ob.submit(market("t", "buy", "1"));
    expect(r.fills[0]!.makerOrderId).toBe(first.id);
    expect(r.fills[0]!.maker).toBe("a");
  });

  it("market 买单：吃穿多个档位", () => {
    const ob = new OrderBook();
    ob.submit(limit("a", "sell", "100", "1"));
    ob.submit(limit("b", "sell", "101", "1"));
    ob.submit(limit("c", "sell", "102", "5"));
    const r = ob.submit(market("t", "buy", "2.5"));
    expect(r.fills.map((f) => [f.price, f.qty])).toEqual([
      [F("100"), F("1")],
      [F("101"), F("1")],
      [F("102"), F("0.5")],
    ]);
    expect(r.resting).toBeNull();
    expect(ob.snapshot(5).asks).toEqual([[F("102"), F("4.5")]]);
  });

  it("market 单遇到空簿：不成交也不挂单", () => {
    const ob = new OrderBook();
    const r = ob.submit(market("t", "buy", "1"));
    expect(r.fills).toHaveLength(0);
    expect(r.resting).toBeNull();
    expect(ob.snapshot(5)).toEqual({ bids: [], asks: [] });
  });

  it("market 单流动性不足：吃完就停", () => {
    const ob = new OrderBook();
    ob.submit(limit("a", "sell", "100", "1"));
    const r = ob.submit(market("t", "buy", "5"));
    expect(r.fills).toHaveLength(1);
    expect(r.fills[0]!.qty).toBe(F("1"));
    expect(r.resting).toBeNull();
    expect(ob.bestAsk()).toBeNull();
  });

  it("撤单：从簿和快照里移除", () => {
    const ob = new OrderBook();
    const o = ob.submit(limit("a", "sell", "100", "1")).resting!;
    expect(ob.cancel(o.id, "someone-else")).toBeNull(); // 不能撤别人的
    const cancelled = ob.cancel(o.id, "a");
    expect(cancelled?.id).toBe(o.id);
    expect(ob.cancel(o.id, "a")).toBeNull();             // 重复撤返回 null
    expect(ob.bestAsk()).toBeNull();
    expect(ob.snapshot(5).asks).toEqual([]);
    expect(ob.ordersOf("a")).toEqual([]);
  });

  it("快照：同价订单数量合并，且按深度截断", () => {
    const ob = new OrderBook();
    ob.submit(limit("a", "buy", "99", "1"));
    ob.submit(limit("b", "buy", "99", "2"));
    ob.submit(limit("c", "buy", "98", "1"));
    ob.submit(limit("d", "buy", "97", "1"));
    const s = ob.snapshot(2);
    expect(s.bids).toEqual([
      [F("99"), F("3")],
      [F("98"), F("1")],
    ]);
    expect(ob.bestBid()).toBe(F("99"));
  });

  it("limit 单吃穿多档后剩余挂单", () => {
    const ob = new OrderBook();
    ob.submit(limit("a", "sell", "100", "1"));
    ob.submit(limit("b", "sell", "101", "1"));
    ob.submit(limit("c", "sell", "110", "1")); // 超出 105，不该被吃
    const r = ob.submit(limit("t", "buy", "105", "3"));
    expect(r.fills.map((f) => f.price)).toEqual([F("100"), F("101")]);
    expect(r.resting?.remaining).toBe(F("1"));
    expect(ob.bestBid()).toBe(F("105"));
    expect(ob.bestAsk()).toBe(F("110"));
  });

  it("ordersOf：只返回该用户还在簿上的单", () => {
    const ob = new OrderBook();
    ob.submit(limit("a", "buy", "90", "1"));
    ob.submit(limit("a", "sell", "110", "1"));
    ob.submit(limit("b", "sell", "120", "1"));
    expect(ob.ordersOf("a").map((o) => o.price).sort((a, b) => (a < b ? -1 : 1))).toEqual([F("90"), F("110")]);
    expect(ob.ordersOf("b")).toHaveLength(1);
  });
});

describe.each(["buy", "sell"] as const)("time in force: %s", (side) => {
  const opposite = side === "buy" ? "sell" : "buy";
  const better = side === "buy" ? "99" : "101";
  const worse = side === "buy" ? "101" : "99";
  const incoming = (timeInForce: "IOC" | "FOK", qty = "3") => ({
    ...limit("taker", side, "100", qty), timeInForce,
  });

  it.each(["IOC", "FOK"] as const)("%s fills across prices and same-price FIFO makers", (tif) => {
    const ob = new OrderBook();
    const first = ob.submit(limit("a", opposite, better, "1")).resting!;
    const second = ob.submit(limit("b", opposite, "100", "1")).resting!;
    const third = ob.submit(limit("c", opposite, "100", "2")).resting!;
    const r = ob.submit(incoming(tif));
    expect(r.resting).toBeNull();
    expect(r.fills.map(f => [f.makerOrderId, f.price, f.qty])).toEqual([
      [first.id, F(better), F("1")], [second.id, F("100"), F("1")], [third.id, F("100"), F("1")],
    ]);
    expect(ob.get(third.id)?.remaining).toBe(F("1"));
    expect(ob.ordersOf("taker")).toEqual([]);
  });

  it("IOC fills only eligible liquidity and never rests its remainder", () => {
    const ob = new OrderBook();
    const eligible = ob.submit(limit("a", opposite, better, "1")).resting!;
    const outside = ob.submit(limit("b", opposite, worse, "5")).resting!;
    const before = structuredClone(outside);
    const r = ob.submit(incoming("IOC"));
    expect(r.fills.map(f => [f.makerOrderId, f.qty])).toEqual([[eligible.id, F("1")]]);
    expect(r.resting).toBeNull();
    expect(ob.get(outside.id)).toEqual(before);
    expect(ob.ordersOf("taker")).toEqual([]);
  });

  it.each(["IOC", "FOK"] as const)("%s on an empty book does not rest", (tif) => {
    const ob = new OrderBook();
    expect(ob.submit(incoming(tif))).toEqual({ fills: [], resting: null });
    expect(ob.snapshot()).toEqual({ bids: [], asks: [] });
  });

  it("FOK ignores out-of-limit depth and kills before any mutation or sequence allocation", () => {
    const ob = new OrderBook();
    const first = ob.submit(limit("a", opposite, better, "1")).resting!;
    const last = ob.submit(limit("b", opposite, worse, "10")).resting!;
    const before = structuredClone([first, last]);
    const depth = ob.snapshot();
    const input = incoming("FOK");
    expect(ob.submit(input)).toEqual({ fills: [], resting: null });
    expect([ob.get(first.id), ob.get(last.id)]).toEqual(before);
    expect(ob.snapshot()).toEqual(depth);
    expect(ob.get(input.id)).toBeUndefined();
    const next = ob.submit(limit("c", opposite, worse, "1")).resting!;
    expect(next.seq).toBe(last.seq + 1);
    expect(ob.submit(incoming("IOC", "1")).fills[0].makerOrderId).toBe(first.id);
  });

  it.each(["IOC", "FOK"] as const)("%s rejects own liquidity after another maker atomically", (tif) => {
    const ob = new OrderBook();
    const first = ob.submit(limit("a", opposite, better, "1")).resting!;
    const own = ob.submit(limit("TaKeR", opposite, "100", "1")).resting!;
    const before = structuredClone([first, own]);
    const depth = ob.snapshot();
    // FOK is also insufficient: self-trade must still be detected.
    expect(() => ob.submit(incoming(tif))).toThrow(SelfTradeError);
    expect([ob.get(first.id), ob.get(own.id)]).toEqual(before);
    expect(ob.snapshot()).toEqual(depth);
    const next = ob.submit(limit("c", opposite, worse, "1")).resting!;
    expect(next.seq).toBe(own.seq + 1);
  });

  it.each(["IOC", "FOK"] as const)("%s allows own liquidity beyond the needed FIFO quantity", (tif) => {
    const ob = new OrderBook();
    const first = ob.submit(limit("a", opposite, "100", "3")).resting!;
    const own = ob.submit(limit("taker", opposite, "100", "1")).resting!;
    expect(ob.submit(incoming(tif)).fills.map(f => f.makerOrderId)).toEqual([first.id]);
    expect(own.remaining).toBe(F("1"));
  });

  it.each(["IOC", "FOK"] as const)("%s allows own liquidity outside the price limit", (tif) => {
    const ob = new OrderBook();
    const own = ob.submit(limit("taker", opposite, worse, "10")).resting!;
    expect(ob.submit(incoming(tif))).toEqual({ fills: [], resting: null });
    expect(ob.get(own.id)?.remaining).toBe(F("10"));
  });
});
