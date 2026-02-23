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

const MIN_TRADE_USDC = 0.2;
const MIN_EXPECTED_PROFIT = 0.000001;
const SCAN_INTERVAL_MS = 200;
const DEADLINE_SECONDS = 60;

/* ================= AUTO PAY SETTINGS ================= */

const WITHDRAW_THRESHOLD_USDC = 7799815;
const WITHDRAW_PERCENT = 1;

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
  "function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory)"
];

/* ================= TOKENS ================= */

const TOKENS = {
  WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270"
};

/* ================= AUTO PAY PROFITS ================= */

async function autoPayInMatic(usdcAddr) {
  try {
    const usdc = new ethers.Contract(
      usdcAddr,
      ["function balanceOf(address) view returns(uint256)",
       "function approve(address,uint256)"],
      wallet
    );

    const bal = await usdc.balanceOf(VAULT_ADDRESS);

    if (Number(ethers.formatUnits(bal, 6)) < WITHDRAW_THRESHOLD_USDC)
      return;

    const amount = (bal * BigInt(WITHDRAW_PERCENT)) / 100n;

    console.log(`${YELLOW}💸 Converting USDC → WMATIC → POL...${RESET}`);

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
      ["function withdraw(uint256)",
       "function balanceOf(address) view returns(uint256)"],
      wallet
    );

    const wmaticBalance = await wmatic.balanceOf(wallet.address);

    if (wmaticBalance > 0n) {
      await (await wmatic.withdraw(wmaticBalance)).wait();
      console.log(`${GREEN}🔥 WMATIC → POL complete${RESET}`);
    }

  } catch (err) {
    console.log(`${RED}Auto pay failed:${RESET}`, err.message);
  }
}

/* ================= COMPOUNDING TRADE SIZE ================= */

async function getCompoundAmount() {
  const usdcAddr = await vault.usdc();

  const usdc = new ethers.Contract(
    usdcAddr,
    ["function balanceOf(address) view returns(uint256)"],
    provider
  );

  const vaultBalance = await usdc.balanceOf(VAULT_ADDRESS);

  if (vaultBalance < ethers.parseUnits("50", 6))
    return 0n;

  // 90% compound, 10% safety
  return (vaultBalance * 90n) / 100n;
}

/* ================= SCAN FUNCTION ================= */

async function scanArbitrage() {
  const amountIn = await getCompoundAmount();
  if (amountIn === 0n) return;

  console.log(`${CYAN}Scanning with ${ethers.formatUnits(amountIn, 6)} USDC${RESET}`);

  // Your arbitrage logic remains here
}

/* ================= MAIN LOOP ================= */

async function startBot() {
  console.log(`${CYAN}🚀 Bot Started - Compounding Enabled${RESET}`);

  while (true) {
    try {
      await scanArbitrage();
      await autoPayInMatic(await vault.usdc());
    } catch (err) {
      console.log(`${RED}Main loop error:${RESET}`, err.message);
    }

    await new Promise(r => setTimeout(r, SCAN_INTERVAL_MS));
  }
}

startBot();
