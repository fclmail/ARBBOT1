import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config({ override: false });

/* ================= CONFIG ================= */

const RPC_POLYGON =
  "https://polygon-bor-rpc.publicnode.com";

const PRIVATE_KEY =
  process.env.PRIVATE_KEY?.trim();

if (!PRIVATE_KEY)
  throw new Error("PRIVATE_KEY missing");

const SCAN_INTERVAL_MS = 10000;
const DEADLINE_SECONDS = 6000;
const MAX_BATCH_SIZE = 3;
const WORKERS = 16;
const MIN_EDGE = 0.000001;

/* ================= COLORS ================= */

const GREEN = "\x1b[32m";
const RESET = "\x1b[0m";

/* ================= PROVIDER ================= */

const provider =
  new ethers.JsonRpcProvider(RPC_POLYGON);

const wallet =
  new ethers.Wallet(PRIVATE_KEY, provider);

/* ================= ADDRESSES ================= */

const VAULT_ADDRESS =
  "0xC1888f15C47e79E45342Dea9249622476A83563f";

const TOKENS = {
  USDC: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
  WBTC: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",
  DAI:  "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063",
  WMATIC:"0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  WETH: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619"
};

const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  Dfyn:      "0xA102072A4C07F06EC3B4900FDC4C7B80b6c57429",
  Firebird:  "0xe0C9D6E8c2C5d4B9A6F7D0A6C2e20e671e7E55cA",
  ApeSwap:   "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607",
  Wault:     "0xa98ea6356a316b44bf710d5f9b6b4ea0081409ef"
};

/* ================= CONTRACTS ================= */

const routerAbi = [
  "function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory)"
];

const erc20Abi = [
  "function balanceOf(address) view returns (uint256)"
];

const routerContracts =
  Object.fromEntries(
    Object.values(routers).map(addr => [
      addr,
      new ethers.Contract(addr, routerAbi, provider)
    ])
  );

const USDC =
  new ethers.Contract(
    TOKENS.USDC,
    erc20Abi,
    provider
  );

/* ================= STATE ================= */

let tradeQueue = [];

/* ================= UTIL ================= */

const sleep = ms =>
  new Promise(r => setTimeout(r, ms));

async function quote(routerAddr, amountIn, path) {
  try {
    const router = routerContracts[routerAddr];
    const amounts =
      await router.getAmountsOut(amountIn, path);
    return amounts.at(-1);
  } catch {
    return null;
  }
}

/* ================= PROFIT CHECK ================= */

async function evaluateTrade(
  buyRouter,
  sellRouter,
  token
) {

  if (token === TOKENS.USDC)
    return null;

  const amountIn =
    ethers.parseUnits("0.02", 6);

  const buyPath =
    [TOKENS.USDC, token];

  const buyOut =
    await quote(
      buyRouter,
      amountIn,
      buyPath
    );

  if (!buyOut)
    return null;

  const sellOut =
    await quote(
      sellRouter,
      buyOut,
      [token, TOKENS.USDC]
    );

  if (!sellOut)
    return null;

  const profit =
    Number(
      ethers.formatUnits(sellOut,6)
    ) -
    Number(
      ethers.formatUnits(amountIn,6)
    );

  if (profit < MIN_EDGE)
    return null;

  console.log(
    GREEN +
    `PROFIT FOUND: ${profit.toFixed(6)} USDC` +
    RESET
  );

  return {
    buyRouter,
    sellRouter,
    amountIn,
    buyPath,
    sellPath: [token, TOKENS.USDC]
  };
}

/* ================= SCAN ================= */

async function scan() {

  console.log("Scanning pools...");

  const tasks = [];

  for (const buy of Object.values(routers)) {
    for (const sell of Object.values(routers)) {
      if (buy === sell) continue;

      for (const token of Object.values(TOKENS)) {
        if (token === TOKENS.USDC) continue;

        tasks.push({ buy, sell, token });
      }
    }
  }

  let index = 0;

  async function worker() {
    while (index < tasks.length) {
      const task = tasks[index++];
      const trade =
        await evaluateTrade(
          task.buy,
          task.sell,
          task.token
        );
      if (trade)
        tradeQueue.push(trade);
    }
  }

  await Promise.all(
    Array.from({ length: WORKERS }, worker)
  );

  console.log(
    `Buffer: ${Math.min(tradeQueue.length, MAX_BATCH_SIZE)}/${MAX_BATCH_SIZE}`
  );
}

/* ================= EXECUTE ================= */

async function executeBatch() {

  if (!tradeQueue.length)
    return;

  const trades =
    tradeQueue.slice(0, MAX_BATCH_SIZE);

  const deadline =
    Math.floor(Date.now()/1000)
    + DEADLINE_SECONDS;

  const batch = {
    buyRouters: trades.map(t=>t.buyRouter),
    sellRouters: trades.map(t=>t.sellRouter),
    amountsInUSDC: trades.map(t=>t.amountIn),
    pathsToToken: trades.map(t=>t.buyPath),
    pathsToUSDC: trades.map(t=>t.sellPath),
    deadline
  };

  try {

    console.log("\nExecuting batch...\n");

    const before =
      await USDC.balanceOf(VAULT_ADDRESS);

    const tx =
      await wallet.sendTransaction; // placeholder safety

    // NOTE:
    // Replace with your real contract call:
    // await vault.executeFlashBatchArbitrage(batch)

    tradeQueue = [];

    const after =
      await USDC.balanceOf(VAULT_ADDRESS);

    const netProfit =
      Number(
        ethers.formatUnits(after - before,6)
      );

    console.log(
      `\nNet Profit Deposited To Vault: ${netProfit.toFixed(6)} USDC`
    );

  } catch {

    for (let i=0;i<trades.length;i++)
      console.log("Trade skipped");

  }
}

/* ================= MAIN ================= */

async function main() {

  console.log("Bot started 🚀\n");

  const walletBal =
    await provider.getBalance(wallet.address);

  const vaultUsdc =
    await USDC.balanceOf(VAULT_ADDRESS);

  console.log(
    `Wallet MATIC: ${ethers.formatEther(walletBal)}`
  );

  console.log(
    `Vault USDC: ${ethers.formatUnits(vaultUsdc,6)}\n`
  );

  while (true) {

    await scan();
    await executeBatch();
    await sleep(SCAN_INTERVAL_MS);

  }
}

main().catch(console.error);
