


// 🟢1 FILE PURPOSE  
// scripts/arbitrage.js  
// This script scans DEX prices on Polygon and executes arbitrage  
// trades through a deployed Vault smart contract.  

import dotenv from "dotenv";  
import { ethers } from "ethers";  

/**  
 * 🟢2 ENVIRONMENT HANDLING (unchanged)  
 */  
dotenv.config({ override: false });  

/* ================= CONFIG ================= */  

// The following sections are kept identical to your original, only extended with fixes.  
// RPC URL and PRIVATE KEY validation remain as you had them.  

const RPC_RAW =  
  process.env.RPC_POLYGON ||  
  process.env.POLYGON_RPC ||  
  process.env.RPC_URL ||  
  "";  

const PRIVATE_KEY_RAW =  
  process.env.WALLET_PRIVATE_KEY ||  
  process.env.PRIVATE_KEY ||  
  "";  

const RPC_POLYGON = RPC_RAW.trim();  
const WALLET_PRIVATE_KEY = PRIVATE_KEY_RAW.trim();  

if (!RPC_POLYGON) throw new Error("RPC_POLYGON is missing or empty");  
if (!WALLET_PRIVATE_KEY) throw new Error("WALLET_PRIVATE_KEY is missing or empty");  

/* ================= CONSTANTS ================= */  

// 🟢7 TRADE SETTINGS  
const MIN_TRADE_USDC = 1.7;  
const MIN_EXPECTED_PROFIT = 0.01; // Match contract's minimumProfitUSDC  
const SLIPPAGE_PCT = 0.05;  
const SCAN_INTERVAL_MS = 10_000;  
const DEADLINE_SECONDS = 60;  

/* ================= PROVIDER ================= */  

// 🟢8 BLOCKCHAIN CONNECTION  
const provider = new ethers.JsonRpcProvider(RPC_POLYGON);  

// 🟢9 WALLET INSTANCE  
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);  

/* ================= VAULT CONTRACT ================= */  

// 🟢10 VAULT CONTRACT ADDRESS  
const VAULT_ADDRESS = "0x621F7ccEb67136f7922E36aF56137e7A1dbA22f1";  

// 🟢11 VAULT ABI  
const vaultAbi = [  
  {  
    inputs: [  
      { internalType: "address", name: "buyRouter", type: "address" },  
      { internalType: "address", name: "sellRouter", type: "address" },  
      { internalType: "uint256", name: "amountInUSDC", type: "uint256" },  
      { internalType: "address[]", name: "pathToToken", type: "address[]" },  
      { internalType: "address[]", name: "pathToUSDC", type: "address[]" },  
      { internalType: "uint256", name: "deadline", type: "uint256" }  
    ],  
    name: "executeArbitrage",  
    outputs: [],  
    stateMutability: "nonpayable",  
    type: "function"  
  },  
  {  
    inputs: [],  
    name: "usdc",  
    outputs: [{ type: "address" }],  
    stateMutability: "view",  
    type: "function"  
  }  
];  

// 🟢12 VAULT CONTRACT INSTANCE  
const vault = new ethers.Contract(VAULT_ADDRESS, vaultAbi, wallet);  

/* ================= ROUTERS ================= */  

// 🟢13 DEX ROUTERS  
const routers = {  
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",  
  Wault: "0xa98ea6356a316b44bf710d5f9b6b4ea0081409ef",  
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",  
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"  
};  

// 🟢14 ROUTER ABI  
const routerAbi = [  
  "function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory)"  
];  

/* ================= TOKENS ================= */  

// 🟢15 TOKENS — continued  
const TOKENS = {  
  USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",  
  WBTC: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",  
  CRV: "0x172370d5cd63279efa6d502dab29171933a610af",  
  DAI: "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063",  
  WETH: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",  
  WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",  
  USDC: "0x2791Ca1B585D7A5b7784A3C0d8a8e6b6c9d3a3d", // canonical usdc on polygon  
  LINK: "0x514910771AF9Ca656af840dff83E8264EcF986CA",  
  AAVE: "0xD04647B7CB523bb9f26730E5C6B6f3aD1a1e5f36"  
};  

/* ================= HELPERS ================= */  

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));  

async function quote(routerAddr, amountIn, path) {  
  try {  
    const router = new ethers.Contract(routerAddr, routerAbi, provider);  
    const amounts = await router.getAmountsOut(amountIn, path);  
    return amounts[amounts.length - 1];  
  } catch (err) {  
    console.error("quote failed", err);  
    return null;  
  }  
}  

function buildPaths(usdc, token) {  
  return [  
    [usdc, token],  
    [usdc, TOKENS.WMATIC, token],  
    [usdc, TOKENS.WETH, token],  
    [usdc, TOKENS.USDT, token],  
    [usdc, TOKENS.DAI, token],  
    [usdc, TOKENS.WMATIC, TOKENS.WETH, token]  
  ];  
}  

async function ensureUSDCAllowance(tokenOwner, spender, amountNeeded) {  
  // This function checks balance/allowance and approves if needed  
  try {  
    const erc20Abi = [  
      "function balanceOf(address owner) view returns (uint256)",  
      "function allowance(address owner, address spender) view returns (uint256)",  
      "function approve(address spender, uint256 amount) returns (bool)"  
    ];  
    const usdcContract = new ethers.Contract(tokenOwner, erc20Abi, provider);  

    const balance = await usdcContract.balanceOf(wallet.address);  
    if (balance.lt(amountNeeded)) {  
      console.warn("USDC balance low for required amount", balance.toString(), amountNeeded.toString());  
      // continue; arb may still execute if not enough, but we log  
    }  

    const allowed = await usdcContract.allowance(wallet.address, vault.address);  
    if (allowed.lt(amountNeeded)) {  
      const tx = await usdcContract.connect(wallet).approve(vault.address, amountNeeded);  
      await tx.wait();  
      console.log("✅ USDC allowance updated");  
    } else {  
      console.log("🔒 USDC allowance sufficient");  
    }  
  } catch (e) {  
    console.error("USDC allowance check failed", e);  
  }  
}  

/* ================= CORE LOGIC ================= */  

async function tryArb(buyRouter, sellRouter, tokenAddr) {
  // Fetch on-chain USDC address from Vault
  const usdc = await vault.usdc();
  // amountInUSDC in USDC's decimals (6)
  const amountIn = ethers.parseUnits(MIN_TRADE_USDC.toString(), 6);

  // Build potential buy paths using on-chain USDC address
  const buyPaths = buildPaths(usdc, tokenAddr);

  let bestBuyOut = null;
  let bestBuyPath = null;

  for (const p of buyPaths) {
    const out = await quote(buyRouter, amountIn, p);
    if (!out) continue;
    if (!bestBuyOut || out.gt(bestBuyOut)) {
      bestBuyOut = out;
      bestBuyPath = p;
    }
  }

  if (!bestBuyOut) return;

  // Sell path: token -> USDC (direct)
  const sellPath = [tokenAddr, usdc];
  const sellOut = await quote(sellRouter, bestBuyOut, sellPath);
  if (!sellOut) return;

  // Convert to human-readable USDC amount
  const receivedUSDC = Number(ethers.formatUnits(sellOut, 6));
  const profit = receivedUSDC - MIN_TRADE_USDC;

  if (profit < MIN_EXPECTED_PROFIT) return;

  const deadline = Math.floor(Date.now() / 1000) + DEADLINE_SECONDS;

  console.log(`🔥 ARB FOUND | Profit ≈ ${profit.toFixed(6)} USDC`);
  console.log(`   buyRouter: ${buyRouter}`);
  console.log(`   sellRouter: ${sellRouter}`);
  console.log(`   amountInUSDC: ${MIN_TRADE_USDC}`);
  console.log(`   bestBuyPath: ${bestBuyPath?.map((a) => a).join(" -> ")}`);
  console.log(`   sellPath: ${sellPath.map((a) => a).join(" -> ")}`);
  console.log(`   deadline: ${deadline}`);

  // Ensure USDC allowance is present for Vault
  await ensureUSDCAllowance(wallet.address, VAULT_ADDRESS, amountIn);

  // Gas data (approximate optimization)
  const fee = await provider.getFeeData();

  try {
    const tx = await vault.executeArbitrage(
      buyRouter,
      sellRouter,
      amountIn,
      bestBuyPath,
      sellPath,
      deadline,
      {
        maxFeePerGas: fee.maxFeePerGas ? fee.maxFeePerGas.mul(120).div(100) : undefined,
        maxPriorityFeePerGas: fee.maxPriorityFeePerGas
          ? fee.maxPriorityFeePerGas.mul(120).div(100)
          : undefined
      }
    );

    console.log(`⛓ TX SENT: ${tx.hash}`);

    tx.wait()
      .then(() => {
        console.log(`✅ ARB EXECUTED & CONFIRMED`);
      })
      .catch((err) => {
        console.error("❌ TX CONFIRMATION FAILED", err);
      });
  } catch (e) {
    console.error("⚠️ ARB EXECUTION REVERTED", e);
  }
}

/* ================= SCANNER ================= */

async function scan() {
  console.log(`🔍 Scan started @ ${new Date().toISOString()}`);

  for (const tokenAddr of Object.values(TOKENS)) {
    for (const buyRouter of Object.values(routers)) {
      for (const sellRouter of Object.values(routers)) {
        if (buyRouter === sellRouter) continue;
        try {
          await tryArb(buyRouter, sellRouter, tokenAddr);
          await sleep(100);
        } catch (e) {
          console.log(`⚠️ ${e?.message ?? e}`);
        }
      }
    }
  }
}

/* ================= MAIN LOOP ================= */

// Entry point
console.log("🚀 Arbitrage bot started");

setInterval(() => {
  scan().catch(console.error);
}, SCAN_INTERVAL_MS);
