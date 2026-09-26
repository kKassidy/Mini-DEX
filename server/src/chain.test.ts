import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createChain } from "./chain.js";
import { Ledger, type Asset } from "./ledger.js";

interface EventLog {
  eventName: "Deposit" | "Withdraw";
  args: { user: string; token: string; amount: bigint };
}
interface WatchOptions {
  fromBlock?: bigint;
  onLogs: (logs: EventLog[]) => void;
}

const rpc = vi.hoisted(() => ({
  getBlockNumber: vi.fn<() => Promise<bigint>>(),
  getContractEvents: vi.fn<() => Promise<EventLog[]>>(),
  watchContractEvent: vi.fn<(options: WatchOptions) => () => void>(),
}));

vi.mock("viem", async (importOriginal) => ({
  ...await importOriginal<typeof import("viem")>(),
  createPublicClient: vi.fn(() => rpc),
  http: vi.fn(),
}));
vi.mock("viem/accounts", () => ({
  privateKeyToAccount: vi.fn(() => ({
    address: "0x0000000000000000000000000000000000000005",
    signTypedData: vi.fn(),
  })),
}));

const USER = "0x0000000000000000000000000000000000000001";
const WAVAX = "0x0000000000000000000000000000000000000002";
const USDC = "0x0000000000000000000000000000000000000003";
const UNIT_WEI = 10n ** 10n;
const deposit = (amount: bigint, token = WAVAX): EventLog => ({
  eventName: "Deposit", args: { user: USER, token, amount },
});

function setup() {
  const ledger = new Ledger();
  const onDeposit = vi.fn((user: string, asset: Asset, amount: bigint) => ledger.credit(user, asset, amount));
  const chain = createChain({
    chainId: 31337, rpcUrl: "https://rpc.invalid",
    vault: "0x0000000000000000000000000000000000000004",
    usdc: USDC, wavax: WAVAX,
    signerKey: "0x", // Inert placeholder: the account factory is mocked.
  });
  return { ledger, onDeposit, chain };
}

beforeEach(() => {
  vi.clearAllMocks();
  rpc.getBlockNumber.mockResolvedValue(100n);
  rpc.watchContractEvent.mockReturnValue(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe.each(["historical", "live"] as const)("%s deposit processing", (mode) => {
  async function processBatch(chain: ReturnType<typeof createChain>, onDeposit: ReturnType<typeof setup>["onDeposit"], logs: EventLog[]) {
    if (mode === "historical") {
      rpc.getContractEvents.mockResolvedValue(logs);
      chain.watchDeposits(onDeposit, { fromBlock: 0n });
      await vi.waitFor(() => expect(rpc.watchContractEvent).toHaveBeenCalledOnce());
      expect(rpc.watchContractEvent.mock.calls[0][0].fromBlock).toBe(101n);
      expect(console.error).not.toHaveBeenCalled();
    } else {
      chain.watchDeposits(onDeposit);
      rpc.watchContractEvent.mock.calls[0][0].onLogs(logs);
    }
  }

  it.each([1n, UNIT_WEI - 1n])("skips %s wei of dust and credits the next deposit", async (dust) => {
    const { chain, ledger, onDeposit } = setup();
    await processBatch(chain, onDeposit, [deposit(dust), deposit(UNIT_WEI)]);
    expect(onDeposit).toHaveBeenCalledTimes(1);
    expect(onDeposit).toHaveBeenCalledWith(USER, "WAVAX", 1n);
    expect(ledger.get(USER).WAVAX).toEqual({ available: 1n, locked: 0n });
    if (mode === "historical") {
      expect(console.log).toHaveBeenCalledWith("[chain] 回放 0 → 100：Deposit 1 笔，Withdraw 0 笔");
    }
  });

  it("preserves normal WAVAX and USDC credits", async () => {
    const { chain, ledger, onDeposit } = setup();
    await processBatch(chain, onDeposit, [deposit(10n ** 18n), deposit(1_500_000n, USDC)]);
    expect(onDeposit).toHaveBeenCalledTimes(2);
    expect(ledger.get(USER).WAVAX.available).toBe(100_000_000n);
    expect(ledger.get(USER).USDC.available).toBe(150_000_000n);
  });
});

it("propagates an unrelated live deposit callback error", () => {
  const { chain } = setup();
  const error = new Error("deposit callback failed");
  const onDeposit = vi.fn(() => { throw error; });
  chain.watchDeposits(onDeposit);
  expect(() => rpc.watchContractEvent.mock.calls[0][0].onLogs([
    deposit(1n), deposit(UNIT_WEI),
  ])).toThrow(error);
  expect(onDeposit).toHaveBeenCalledTimes(1);
  expect(onDeposit).toHaveBeenCalledWith(USER, "WAVAX", 1n);
});

it("keeps historical withdrawal callbacks unchanged, including converted zero", async () => {
  const { chain, onDeposit } = setup();
  const onWithdraw = vi.fn();
  rpc.getContractEvents.mockResolvedValue([1n, 10n ** 18n].map((amount) => ({
    ...deposit(amount), eventName: "Withdraw",
  })));
  chain.watchDeposits(onDeposit, { fromBlock: 0n, onWithdraw });
  await vi.waitFor(() => expect(rpc.watchContractEvent).toHaveBeenCalledOnce());
  expect(onDeposit).not.toHaveBeenCalled();
  expect(onWithdraw).toHaveBeenNthCalledWith(1, USER, "WAVAX", 0n);
  expect(onWithdraw).toHaveBeenNthCalledWith(2, USER, "WAVAX", 100_000_000n);
  expect(rpc.watchContractEvent.mock.calls[0][0].fromBlock).toBe(101n);
});
