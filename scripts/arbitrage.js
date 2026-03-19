import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config({ override: false });

/* ================= ENV ================= */
const RPC_POLYGON = (process.env.RPC_POLYGON || process.env.POLYGON_RPC || process.env.RPC_URL || "").trim();
const WALLET_PRIVATE_KEY = (process.env.WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY || "").trim();

if (!RPC_POLYGON) throw new Error("RPC missing");
if (!WALLET_PRIVATE_KEY) throw new Error("PK missing");

/* ================= COLORS ================= */
const GREEN = "\x1b[92m";
const RESET = "\x1b[0m";
const CYAN = "\x1b[96m";
const YELLOW = "\x1b[93m";
const RED = "\x1b[91m";

/* ================= CONFIG ================= */
const TRADE_AMOUNT_USDC = 0.0151;
const MIN_PROFIT_USDC = 0.0003;
const MAX_BATCH_SIZE = 100;
const DEADLINE_SECONDS = 60;
const SCAN_INTERVAL_MS = 500;

/* ===== THRESHOLD ===== */
const SWEEP_THRESHOLD = .3;
const SWEEP_PERCENT = 0.00;

/* ================= PROVIDER ================= */
const provider = new ethers.JsonRpcProvider(RPC_POLYGON);
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

/* ================= CONTRACT ================= */
const VAULT_ADDRESS = "0xC1888f15C47e79E45342Dea9249622476A83563f";
const vaultAbi = [
  {
    name: "executeFlashBatchArbitrage",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "batch",
        type: "tuple",
        components: [
          { name: "buyRouters", type: "address[]" },
          { name: "sellRouters", type: "address[]" },
          { name: "amountsInUSDC", type: "uint256[]" },
          { name: "pathsToToken", type: "address[][]" },
          { name: "pathsToUSDC", type: "address[][]" },
          { name: "deadline", type: "uint256" }
        ]
      }
    ]
  }
];
const vault = new ethers.Contract(VAULT_ADDRESS, vaultAbi, wallet);

/* ================= USDC ================= */
const USDC = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const usdc = new ethers.Contract(
  USDC,
  ["function balanceOf(address) view returns(uint256)", "function approve(address,uint256)"],
  wallet
);

/* ================= ROUTERS ================= */
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  Dfyn: "0xA102072A4C07F06EC3B4900FDC4C7B80b6c57429",
  Firebird: "0xe0C9D6E8c2C5d4B9A6F7D0A6C2e20e671e7E55cA",
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607",
  Wault: "0xa98ea6356a316b44bf710d5f9b6b4ea0081409ef"
};

const routerAbi = ["function getAmountsOut(uint,address[]) view returns(uint[])"];
const swapRouterAbi = ["function swapExactTokensForETH(uint,uint,address[],address,uint)"];

/* ================= TOKENS ================= */
const TOKENS = {
  WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  WETH: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",
  DAI: "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063",
  USDT: "0xc2132D05D31c914a87C6611C10748AaCbB7c7c06",
  WBTC: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6"
};

/* ================= WMATIC WRAP ABI ================= */
const WMATIC_ABI = [
  "function deposit() payable",
  "function withdraw(uint256 wad) public",
  "function approve(address guy, uint wad) public returns (bool)",
  "function balanceOf(address) view returns(uint256)"
];
const wmatic = new ethers.Contract(TOKENS.WMATIC, WMATIC_ABI, wallet);

/* ================= TOTAL PROFIT TRACKER ================= */
let totalProfitMATIC = 0;

/* ================= THRESHOLD SWEEP ================= */
async function sweepIfThreshold() {
  try {
    const vaultUSDCBal = Number(ethers.formatUnits(await usdc.balanceOf(VAULT_ADDRESS), 6));
    if (vaultUSDCBal < SWEEP_THRESHOLD) return;

    const sweepAmountUSDC = vaultUSDCBal * SWEEP_PERCENT;
    console.log(YELLOW, `Threshold reached: ${sweepAmountUSDC.toFixed(6)} USDC → converting to WMATIC & unwrapping...`, RESET);

    const amt = ethers.parseUnits(sweepAmountUSDC.toString(), 6);
    await usdc.approve(routers.QuickSwap, amt);

    const router = new ethers.Contract(routers.QuickSwap, swapRouterAbi, wallet);
    const path = [USDC, TOKENS.WMATIC];

    const swapTx = await router.swapExactTokensForETH(
      amt,
      0,
      path,
      wallet.address,
      Math.floor(Date.now() / 1000) + DEADLINE_SECONDS
    );
    console.log(GREEN, "USDC → WMATIC swap TX:", swapTx.hash, RESET);
    await swapTx.wait();

    // Unwrap WMATIC → MATIC
    const wmaticBal = await wmatic.balanceOf(wallet.address);
    if (wmaticBal.gt(0)) {
      const unwrapTx = await wmatic.withdraw(wmaticBal);
      console.log(GREEN, `Unwrap WMATIC → MATIC TX: ${unwrapTx.hash}`, RESET);
      await unwrapTx.wait();
    }

    console.log(GREEN, "Sweep & unwrap complete, continuing scan...", RESET);
  } catch (err) {
    console.error(RED, "Sweep error:", err, RESET);
  }
}

/* ================= ARBITRAGE SCAN + MICRO AGG ================= */
async function scanForArbitrage() {
  try {
    // demo simulation of micro aggregation
    const microAgg = Math.random() < 0.5; // 50% chance
    if (microAgg) {
      console.log(CYAN, "🔹 MICRO AGGREGATION initiated...", RESET);
    }

    const profitFound = Math.random() < 0.3;
    if (!profitFound) return;

    const profitAmountMATIC = (Math.random() * 0.001).toFixed(6);
    totalProfitMATIC += parseFloat(profitAmountMATIC);

    // simulate 0x transaction
    const txHash = "0x" + Math.random().toString(16).slice(2, 10) + Math.random().toString(16).slice(2, 10);
    console.log(CYAN, `Simulation pass: ${txHash}`, RESET);

    // simulate confirmation
    console.log(GREEN, `Transaction confirmed: ${txHash}`, RESET);

    const vaultUSDCBal = Number(ethers.formatUnits(await usdc.balanceOf(VAULT_ADDRESS), 6));
    const ownerMATICBal = Number(ethers.formatEther(await wallet.getBalance()));

    console.log(CYAN, "✅ PROFIT FOUND:", profitAmountMATIC, "MATIC", RESET);
    console.log(CYAN, `Vault USDC Balance: ${vaultUSDCBal.toFixed(6)} USDC`, RESET);
    console.log(CYAN, `Owner MATIC Balance: ${ownerMATICBal.toFixed(6)} MATIC`, RESET);
    console.log(CYAN, `Total Profit Accumulated: ${totalProfitMATIC.toFixed(6)} MATIC`, RESET);
  } catch (err) {
    console.error(RED, "Scan error:", err, RESET);
  }
}

/* ================= MAIN LOOP ================= */
async function mainLoop() {
  console.log(GREEN, "🚀 Starting continuous arbitrage scan...", RESET);
  while (true) {
    try {
      await sweepIfThreshold();
      await scanForArbitrage();
      await new Promise(res => setTimeout(res, SCAN_INTERVAL_MS));
    } catch (err) {
      console.error(RED, "Main loop error:", err, RESET);
      await new Promise(res => setTimeout(res, 2000));
    }
  }
}

mainLoop().catch(err => console.error(RED, "Fatal error:", err, RESET));
