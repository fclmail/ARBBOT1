
     
import dotenv from "dotenv";  
import { ethers } from "ethers";  

/* ================= CONFIG ================= */  
dotenv.config({ override: false });  

const RPC_POLYGON = (process.env.RPC_POLYGON || process.env.POLYGON_RPC || process.env.RPC_URL || "").trim();  
const WALLET_PRIVATE_KEY = (process.env.WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY || "").trim();  

if (!RPC_POLYGON) throw new Error("RPC_POLYGON is missing or empty");  
if (!WALLET_PRIVATE_KEY) throw new Error("WALLET_PRIVATE_KEY is missing or empty");  

/* ================= CONSTANTS / SAFEGUARDS ================= */  
const MIN_TRADE_USDC = Number(process.env.MIN_TRADE_USDC || .020); // input USDC  
const MIN_EXPECTED_PROFIT = Number(process.env.MIN_EXPECTED_PROFIT || 0.000001); // USDC  
const SCAN_DELAY_MS = Number(process.env.SCAN_DELAY_MS || 4000);  
const DEADLINE_SECONDS = Number(process.env.DEADLINE_SECONDS || 60);  
let MIN_SWEEP_AMOUNT = Number(process.env.MIN_SWEEP_AMOUNT || 0.000001);  
const DRY_RUN = (process.env.DRY_RUN || "false").toLowerCase() === "true";  

// Gas controls (optional)  
const GAS_PRICE_GWEI = process.env.GAS_PRICE_GWEI ? Number(process.env.GAS_PRICE_GWEI) : undefined;  
const GAS_LIMIT = process.env.GAS_LIMIT ? Number(process.env.GAS_LIMIT) : undefined;  
const TX_RETRY_ATTEMPTS = Number(process.env.TX_RETRY_ATTEMPTS || 1);  

/* ================= PROVIDER & WALLET ================= */  
const provider = new ethers.JsonRpcProvider(RPC_POLYGON);  
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);  

/* ================= CONTRACT ================= */  
const VAULT_ADDRESS = "0x621F7ccEb67136f7922E36aF56137e7A1dbA22f1";  
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
const vault = new ethers.Contract(VAULT_ADDRESS, vaultAbi, wallet);  

/* ================= ROUTERS ================= */  
const routers = {  
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",  
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",  
  ApeSwap:   "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"  
};  
const routerAbi = ["function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory)"];  
const swapRouterAbi = ["function swapExactTokensForETH(uint amountIn,uint amountOutMin,address[] calldata path,address to,uint deadline)"];  

/* ================= TOKENS ================= */  
const TOKENS = {  
  USDT:  "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",  
  WBTC:  "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",  
  LINK:  "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39",  
  AAVE:  "0xd6df932a45c0f255f85145f286ea0b292b21c90b",  
  USDC:  "0x2791bca1f2de4661ed88a30c99a7a9449aa84174",  
  DAI:   "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063",  
  WETH:  "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",  
  UNI:   "0xb33eaad8d922b1083446dc23f610c2567fb5180f",  
  FRAX:  "0x45c32fa6df82ead1e2ef74d17b76547eddfaff89",  
  BUSD:  "0x9c9e5fd8bbc25984b178fdce6117defa39d2db39",  
  APE:   "0xb7b31a6bc18e48888545ce79e83e06003be70930",  
  CRV:   "0x172370d5cd63279efa6d502dab29171933a610af",  
  SRM:   "0x6bf2eb299e51fc5df30dec81d9445dde70e3f185",  
  SAND:  "0xbbba073c31bf03b8acf7c28ef0738decf3695683",  
  TUSD:  "0x2e1ad108ff1d8c782fcbbb89aad783ac49586756",  
  WOO:   "0x1b815d120b3ef02039ee11dc2d33de7aa4a8c603",  
  XSGD:  "0xdc3326e71d45186f113a2f448984ca0e8d201995",  
  MV:    "0xA3c322Ad15218fBFAEd26bA7f616249f7705D945",  
  VCNT:  "0x8a16d4bf8a0a716017e8d2262c4ac32927797a2f"  
};  
const WMATIC = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270";  

/* ================= ANSI COLORS ================= */  
const GREEN  = "\x1b[32m";  
const RED    = "\x1b[31m";  
const YELLOW = "\x1b[33m";  
const RESET  = "\x1b[0m";  

/* ================= HELPERS ================= */  
const sleep = (ms) => new Promise(r => setTimeout(r, ms));  

function formatUSDC(n) {  
  try {  
    return Number(ethers.formatUnits(n, 6)).toFixed(6);  
  } catch {  
    return String(n);  
  }  
}  

async function quote(routerAddr, amountIn, path) {  
  try {  
    const router = new ethers.Contract(routerAddr, routerAbi, provider);  
    const amounts = await router.getAmountsOut(amountIn, path);  
    return amounts[amounts.length - 1];  
  } catch (e) {  
    return null;  
  }  
}  

/* ===== METHOD 1: WRAPPER PATH ENGINE ===== */  
const FALLBACK_HOPS = [WMATIC, TOKENS.WETH, TOKENS.DAI, TOKENS.USDT];  

function generatePaths(base, token) {  
  let paths = [];  
  paths.push([base, token]); // direct  
  for (let hop of FALLBACK_HOPS) {  
    if (hop === token) continue;  
    paths.push([base, hop, token]);  
  }  
  return paths;  
}  

/* ===== SWEEP PROFITS TO MATIC ===== */  
async function sweepProfitsToMatic() {  
  try {  
    const usdcAddress = await vault.usdc();  
    const usdcContract = new ethers.Contract(usdcAddress, [  
      "function balanceOf(address) view returns(uint256)",  
      "function approve(address,uint256)"  
    ], wallet);  

    const balance = await usdcContract.balanceOf(VAULT_ADDRESS);  
    const readable = Number(ethers.formatUnits(balance, 6));  

    if (readable < MIN_SWEEP_AMOUNT) return;  

    console.log(`💰 SWEEP INITIATED | USDC balance: ${readable.toFixed(6)}`);  

    await usdcContract.approve(routers.QuickSwap, balance);  

    const router = new ethers.Contract(routers.QuickSwap, swapRouterAbi, wallet);  
    const path = [usdcAddress, WMATIC];  

    const tx = await router.swapExactTokensForETH(balance, 0, path, wallet.address, Math.floor(Date.now()/1000)+60);  
    console.log(`🔁 Converting profits to MATIC: ${tx.hash}`);  
    await tx.wait();  

    console.log("✅ PROFITS CONVERTED TO MATIC AND SENT TO OWNER WALLET");  
  } catch (err) {  
    console.log("⚠️ Sweep error:", err?.message ?? err);  
  }  
}  

/* ===== CORE ARBITRAGE LOGIC ===== */  
async function tryArb(buyRouter, sellRouter, tokenAddr, buyPath = null, sellPath = null) {  
  const usdcAddress = await vault.usdc();  
  const amountIn = ethers.parseUnits(MIN_TRADE_USDC.toString(), 6);  

  const directPathBuy = buyPath || [usdcAddress, tokenAddr];  
  const directPathSell = sellPath || [tokenAddr, usdcAddress];  

  const buyOut = await quote(buyRouter, amountIn, directPathBuy);  
  if (!buyOut) return { profit: 0, success: false };  

  const sellOut = await quote(sellRouter, buyOut, directPathSell);  
  if (!sellOut) return { profit: 0, success: false };  

  const receivedUSDC = Number(ethers.formatUnits(sellOut, 6));  
  const profit = receivedUSDC - MIN_TRADE_USDC;  

  // Show ARB SCAN output  
  const color = profit >= 0 ? GREEN : RED;  
  console.log(`${YELLOW}🔹 ARB SCAN | Token: ${tokenAddr}${RESET}`);  
  console.log(`  Buy on: ${buyRouter} | Buy amount out: ${buyOut ? Number(ethers.formatUnits(buyOut, 18)) : 0}`);  
  console.log(`  Sell on: ${sellRouter} | Sell amount out: ${sellOut ? Number(ethers.formatUnits(sellOut, 18)) : 0}`);  
  console.log(`  Expected Profit: ${color}${profit.toFixed(6)} USDC${RESET}`);  

  if (profit < MIN_EXPECTED_PROFIT) return { profit, success: false };  

  console.log("🔥 EXECUTING ARBITRAGE");  
  const deadline = Math.floor(Date.now()/1000)+DEADLINE_SECONDS;  

  if (DRY_RUN) {  
    console.log("🔎 DRY RUN: would call vault.executeArbitrage with:");  
    console.log(`   buyRouter: ${buyRouter}, sellRouter: ${sellRouter}`);  
    console.log(`   amountInUSDC: ${amountIn.toString()}`);  
    console.log(`   pathToToken: ${JSON.stringify(directPathBuy)}`);  
    console.log(`   pathToUSDC: ${JSON.stringify(directPathSell)}`);  
    console.log(`   deadline: ${deadline}`);  
    return { profit, success: true, dryRun: true, txHash: null };  
  }  

  // Build transaction with optional gas settings  
  let tx;  
  for (let attempt = 0; attempt < TX_RETRY_ATTEMPTS; attempt++) {  
    try {  
      const txOpts = {};  
      if (GAS_PRICE_GWEI) txOpts.gasPrice = ethers.parseUnits(GAS_PRICE_GWEI.toString(), "gwei");  
      if (GAS_LIMIT) txOpts.gasLimit = GAS_LIMIT;  

      tx = await vault.executeArbitrage(  
        buyRouter, sellRouter, amountIn, directPathBuy, directPathSell, deadline, txOpts  
      );  
      console.log(`⛓ TX SENT: ${tx.hash}`);  
      await tx.wait();  
      console.log("✅ PROFIT DEPOSITED TO VAULT");  
      break;  
    } catch (err) {  
      console.log(`⚠️ Arb tx attempt ${attempt+1} failed:`, err?.message ?? err);  
      if (attempt < TX_RETRY_ATTEMPTS - 1) {  
        await sleep(1000);  
        continue;  
      } else {  
        throw err;  
      }  
    }  
  }  

  await sweepProfitsToMatic();  

  return { profit, success: true, dryRun: false, txHash: tx?.hash ?? null };  
}  

/* ===== ENHANCED SCANNER ===== */  
async function scan() {  
  const usdcAddress = await vault.usdc();  

  // Display Wallet and Vault balances  
  const walletMatic = Number(ethers.formatUnits(await provider.getBalance(wallet.address), 18));  
  const vaultUSDC = Number(ethers.formatUnits(  
    await new ethers.Contract(usdcAddress, ["function balanceOf(address) view returns(uint256)"], provider)  
      .balanceOf(VAULT_ADDRESS), 6));  
  console.log(`💎 Wallet MATIC balance: ${walletMatic.toFixed(6)}`);  
  console.log(`💰 Vault USDC balance: ${vaultUSDC.toFixed(6)}`);  

  for (const token of Object.values(TOKENS)) {  
    const buyPaths = generatePaths(usdcAddress, token);  
    const sellPaths = generatePaths(token, usdcAddress);  

    for (const buy of Object.values(routers)) {  
      for (const sell of Object.values(routers)) {  
        if (buy === sell) continue;  

        for (let bPath of buyPaths) {  
          for (let sPath of sellPaths) {  
            try {  
              const arb = await tryArb(buy, sell, token, bPath, sPath);  
              // Respect a small delay between attempts to avoid spamming  
              await sleep(1200);  
              if (arb?.profit && arb.profit >= MIN_EXPECTED_PROFIT) {  
                // Early exit on a profitable dry-run  
                // In production, you might want to continue scanning  
              }  
            } catch (e) {  
              console.log(`⚠️ ${e?.message ?? e}`);
            }
          }
        }
      }
    }
  }
}

/* ===== MAIN LOOP ===== */
(async () => {
  console.log("🚀 Arbitrage bot started");
  while (true) {
    try {
      await scan();
    } catch (err) {
      console.log("⚠️ Scan error:", err?.message ?? err);
    }
    await sleep(SCAN_DELAY_MS);
  }
})();
