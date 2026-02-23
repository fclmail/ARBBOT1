J's v c m🔃📶💰

import dotenv from "dotenv";
import { ethers } from "ethers";

/* ================= ENV ================= */

dotenv.config({ override: false });

const RPC_POLYGON =
  (process.env.RPC_POLYGON ||
    process.env.POLYGON_RPC ||
    process.env.RPC_URL ||
    "").trim();

const WALLET_PRIVATE_KEY =
  (process.env.WALLET_PRIVATE_KEY ||
    process.env.PRIVATE_KEY ||
    "").trim();

if (!RPC_POLYGON) throw new Error("RPC_POLYGON missing");
if (!WALLET_PRIVATE_KEY) throw new Error("PRIVATE_KEY missing");

/* ================= COLORS ================= */

const GREEN = "\x1b[92m";
const RESET = "\x1b[0m";
const CYAN = "\x1b[96m";
const YELLOW = "\x1b[93m";
const RED = "\x1b[91m";

/* ================= CONSTANTS ================= */

const MIN_TRADE_USDC = 0.02;
const MIN_EXPECTED_PROFIT = 0.000001;

const SCAN_INTERVAL_MS = 10_000;
const DEADLINE_SECONDS = 60;

const WITHDRAW_THRESHOLD_USDC = 2;
const WITHDRAW_PERCENT = 100;

/* ================= PROVIDER ================= */

const provider = new ethers.JsonRpcProvider(RPC_POLYGON);
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

/* ================= CONTRACT ================= */

const VAULT_ADDRESS = "0x621F7ccEb67136f7922E36aF56137e7A1dbA22f1";

const vaultAbi = [
  {
    name: "executeArbitrage",
    type: "function",
    inputs: [
      { name: "buyRouter", type: "address" },
      { name: "sellRouter", type: "address" },
      { name: "amountInUSDC", type: "uint256" },
      { name: "pathToToken", type: "address[]" },
      { name: "pathToUSDC", type: "address[]" },
      { name: "deadline", type: "uint256" }
    ],
    outputs: [],
    stateMutability: "nonpayable"
  },
  {
    name: "usdc",
    type: "function",
    outputs: [{ type: "address" }],
    stateMutability: "view"
  },
  {
    name: "approveRouters",
    type: "function",
    inputs: [
      { name: "routers", type: "address[]" },
      { name: "amount", type: "uint256" }
    ],
    outputs: [],
    stateMutability: "nonpayable"
  },
  {
    name: "withdrawERC20",
    type: "function",
    inputs: [
      { name: "tokenAddr", type: "address" },
      { name: "amount", type: "uint256" }
    ],
    outputs: [],
    stateMutability: "nonpayable"
  }
];

const vault = new ethers.Contract(VAULT_ADDRESS, vaultAbi, wallet);

/* ================= ROUTERS ================= */

const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607",
  Wault: "0xa98ea6356a316b44bf710d5f9b6b4ea0081409ef"
};

const routerAbi = [
  "function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory)",
  "function swapExactTokensForTokens(uint,uint,address[],address,uint)"
];

/* ================= TOKENS ================= */

const TOKENS = {
  USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
  WBTC: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",
  APE: "0x4d224452801aced8b2f0aebe155379bb5d594381",
  CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
  DAI: "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063",
  WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  WETH: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",
  LINK: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39",
  AAVE: "0xd6df932a45c0f255f85145f286ea0b292b21c90b"
};

/* ================= HELPERS ================= */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function quote(routerAddr, amountIn, path) {
  try {
    const router = new ethers.Contract(routerAddr, routerAbi, provider);
    const amounts = await router.getAmountsOut(amountIn, path);
    return amounts.at(-1);
  } catch {
    return null;
  }
}

/* ================= BALANCE DISPLAY ================= */

async function showBalances(usdcAddr) {
  const usdc = new ethers.Contract(
    usdcAddr,
    ["function balanceOf(address) view returns(uint256)"],
    provider
  );

  const walletMatic = await provider.getBalance(wallet.address);
  const contractBal = await usdc.balanceOf(VAULT_ADDRESS);

  console.log(`${CYAN}Wallet POL:${RESET} ${ethers.formatEther(walletMatic)}`);
  console.log(`${CYAN}Contract USDC:${RESET} ${ethers.formatUnits(contractBal, 6)}`);
}

/* ================= AUTO PAY PROFITS IN POL ================= */

async function autoPayInPol(usdcAddr) {
  try {
    const usdc = new ethers.Contract(
      usdcAddr,
      [
        "function balanceOf(address) view returns(uint256)",
        "function approve(address,uint256)"
      ],
      wallet
    );

    const bal = await usdc.balanceOf(VAULT_ADDRESS);

    if (Number(ethers.formatUnits(bal, 6)) < WITHDRAW_THRESHOLD_USDC)
      return;

    const amount = (bal * BigInt(WITHDRAW_PERCENT)) / 100n;

    console.log(`${YELLOW}Converting USDC → WMATIC → POL...${RESET}`);

    await (await vault.withdrawERC20(usdcAddr, amount)).wait();
    await (await usdc.approve(routers.QuickSwap, amount)).wait();

    const router = new ethers.Contract(routers.QuickSwap, routerAbi, wallet);

    await (
      await router.swapExactTokensForTokens(
        amount,
        0,
        [usdcAddr, TOKENS.WMATIC],
        wallet.address,
        Math.floor(Date.now() / 1000) + 120
      )
    ).wait();

    const wmatic = new ethers.Contract(
      TOKENS.WMATIC,
      [
        "function withdraw(uint256)",
        "function balanceOf(address) view returns(uint256)"
      ],
      wallet
    );

    const wmaticBalance = await wmatic.balanceOf(wallet.address);

    if (wmaticBalance > 0n) {
      await (await wmatic.withdraw(wmaticBalance)).wait();
      console.log(`${GREEN}WMATIC → POL accumulated${RESET}`);
    }

  } catch (err) {
    console.log(`${RED}Auto POL convert failed:${RESET}`, err.message);
  }
}

/* ================= ARBITRAGE ================= */

async function tryArb(buyRouter, sellRouter, tokenAddr) {
  const usdc = await vault.usdc();
  const amountIn = ethers.parseUnits(MIN_TRADE_USDC.toString(), 6);

  let bestBuyOut, bestBuyPath;
  for (const p of [
    [usdc, tokenAddr],
    [usdc, TOKENS.WMATIC, tokenAddr],
    [usdc, TOKENS.WETH, tokenAddr],
    [usdc, TOKENS.USDT, tokenAddr],
    [usdc, TOKENS.DAI, tokenAddr]
  ]) {
    const out = await quote(buyRouter, amountIn, p);
    if (out && (!bestBuyOut || out > bestBuyOut)) {
      bestBuyOut = out;
      bestBuyPath = p;
    }
  }
  if (!bestBuyOut) return;

  let bestSellOut, bestSellPath;
  for (const p of [
    [tokenAddr, usdc],
    [tokenAddr, TOKENS.WMATIC, usdc],
    [tokenAddr, TOKENS.WETH, usdc],
    [tokenAddr, TOKENS.USDT, usdc],
    [tokenAddr, TOKENS.DAI, usdc]
  ]) {
    const out = await quote(sellRouter, bestBuyOut, p);
    if (out && (!bestSellOut || out > bestSellOut)) {
      bestSellOut = out;
      bestSellPath = p;
    }
  }
  if (!bestSellOut) return;

  const profit = Number(ethers.formatUnits(bestSellOut, 6)) - MIN_TRADE_USDC;
  if (profit < MIN_EXPECTED_PROFIT) return;

  console.log(`${GREEN}PROFIT FOUND:${RESET} ${profit.toFixed(6)} USDC`);

  const deadline = Math.floor(Date.now() / 1000) + DEADLINE_SECONDS;

  try {
    const tx = await vault.executeArbitrage(
      buyRouter,
      sellRouter,
      amountIn,
      bestBuyPath,
      bestSellPath,
      deadline
    );

    console.log(`${GREEN}Arbitrage executed. Tx hash:${RESET} ${tx.hash}`);

    await tx.wait();

    console.log(`${GREEN}Tx confirmed${RESET}`);

    await showBalances(usdc);
    await autoPayInPol(usdc);

  } catch (err) {
    console.log(`${RED}Execution failed:${RESET}`, err.message);
  }
}

/* ================= MAIN LOOP ================= */

async function main() {
  await vault.approveRouters(Object.values(routers), ethers.MaxUint256);

  while (true) {
    for (const buy of Object.values(routers)) {
      for (const sell of Object.values(routers)) {
        if (buy === sell) continue;
        for (const token of Object.values(TOKENS)) {
          await tryArb(buy, sell, token);
        }
      }
    }
    await sleep(SCAN_INTERVAL_MS);
  }
}

main().catch(console.error);
