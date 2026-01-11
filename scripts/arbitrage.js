// scripts/arbitrage.js
// ---------------------------------------------------------
//  ARBITRAGE BOT – VAULT VERSION (FAST AUTO-APPROVE + FULL LOGS)
// ---------------------------------------------------------

import dotenv from "dotenv";
import { ethers, Wallet } from "ethers";
dotenv.config();

/* ===================== GLOBAL SAFETY NET ===================== */
process.on("unhandledRejection", (reason) => {
  console.log("⚠️ Unhandled rejection caught:", reason?.message || reason);
});
process.on("uncaughtException", (err) => {
  console.log("⚠️ Uncaught exception caught:", err.message);
});
/* ============================================================= */

// ----------------- CONFIG -----------------
const RPC = process.env.RPC_POLYGON || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) {
  console.log("❌ Missing PRIVATE KEY");
}

const DRY_RUN = false;                 // true = simulate only
const MIN_TRADE_USDC = 13.30;          // trade size
const MIN_EXPECTED_PROFIT = 0.00001;  // minimum USDC profit
const MIN_PROFIT_PCT = 1.0;
const SLIPPAGE_PCT = 0.05;            // slippage tolerance %
const MAX_PROFIT_PCT = 550;

// ----------------- COLORS -----------------
const colors = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m"
};
const fmt = (n, d = 6) => Number(n).toFixed(d);

// ----------------- PROVIDER / WALLET -----------------
const provider = new ethers.JsonRpcProvider(RPC);
const wallet = new Wallet(PRIVATE_KEY, provider);

// ----------------- VAULT -----------------
const VAULT_ADDRESS = "0x04b0d378cfDD6F2F3895E19ACDc411a4558F875A";

const vaultAbi = [
  "function executeArbitrage(address,address,address,uint256,uint256,uint256,uint256)",
  "function USDC() view returns (address)",
  "function owner() view returns (address)",
  "function approveRouter(address router,address token) external"
];

const vault = new ethers.Contract(VAULT_ADDRESS, vaultAbi, wallet);

// ----------------- ERC20 -----------------
const erc20Abi = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) external returns (bool)"
];

// ----------------- TOKENS -----------------
const tokens = {
  AAVE: { address: "0xd6df932a45c0f255f85145f286ea0b292b21c90b", decimals: 18 },
  APE:{address:"0x4d224452801aced8b2f0aebe155379bb5d594381",decimals:18},
      AXLUSDC:{address:"0x2a2b6055a5c6945f4fe0e814f5d4a13b5a681159",decimals:6},
      BETA:{address:"0x0afaabcad8815b32bf2b64e0dc5e1df2f1454cde",decimals:18},
      BONE:{address:"0xad37e3433ebde20e5fbf531e6c7da1655c60bb8e",decimals:18},
      DAI:{address:"0x8f3cf7ad23cd3cadbd9735aff958023239c6a063",decimals:18},
      DPI:{address:"0x1494ca1f11d487c2bbe4543e90080aeba4ba3c2b",decimals:18},
      FND:{address:"0x292c4eefdda27062049d44d4730d5fe774b5f4c7",decimals:18},
      FREE:{address:"0xe1ae4d4a3a2200ae5ac06e50bca0dd7e52a19238",decimals:18},
      KLIMA:{address:"0x4e78011ce80ee02d2c3e649fb657e45898257815",decimals:9},
      LDO:{address:"0xbb0bb78beeea5cf201b8f2651f48830e64ce45a4",decimals:18},
      MATICX:{address:"0xa3fa99a148fa48d14ed51d610c367c61876997f1",decimals:18},
      OS:{address:"0xd3a691c852cdb01e281545a27064741f0b7f6825",decimals:18},
      QUICK:{address:"0x831753dd7087cac61ab5644b308642cc1c33dc13",decimals:18},
      RNDR:{address:"0x6c3c7886b43d005db8c28a09e8038b87e36cf26c",decimals:18},
      SHIB:{address:"0x6f8a06447ff6fcf75a5fcdb3f8c4bab2da4fc0d0",decimals:18},
      SHIKIGON:{address:"0x3f0fb6e42d160a8def49fe68b8ef4d8a5b7ab119",decimals:18},
      SURE:{address:"0xf638a9594c0c780d6c8bc40fa33efb0ceabf5d57",decimals:18},
      THE7:{address:"0x045f7ffdcc8334e78316a2c1164efb2e5f3815d5",decimals:18},
      TRADE:{address:"0x82362ec182db3cf7829014bc61e9be8a2e82868a",decimals:18},
      UNI:{address:"0x1f9840a85d5af5bf1d1762f925bdaddc4201f984",decimals:18},
      UNI2:{address:"0xb33eaad8d922b1083446dc23f610c2567fb5180f",decimals:18}, // separate key
      USDC:{address:"0x2791bca1f2de4661ed88a30c99a7a9449aa84174",decimals:6},
      USDT:{address:"0xc2132d05d31c914a87c6611c10748aeb04b58e8f",decimals:6},
      WBTC:{address:"0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",decimals:8},
      XSGD:{address:"0x70e8de73ce022f373d5a9f00b0ec0cf5835b0fc0",decimals:6},
  CRV:  { address: "0x172370d5cd63279efa6d502dab29171933a610af", decimals: 18 },
  LINK: { address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", decimals: 18 },
  WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 }
};

// ----------------- ROUTERS -----------------
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap:   "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

// ----------------- BASE FALLBACKS -----------------
const BASES = [
  "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", // USDC
  "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", // USDT
  "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", // WETH
  "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270"  // WMATIC
];

// ----------------- HELPERS -----------------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function sanePct(p) {
  return Number.isFinite(p) && p > -1000 && p < MAX_PROFIT_PCT;
}

async function vaultUSDC() {
  try {
    return await vault.USDC();
  } catch {
    return BASES[0];
  }
}

async function vaultBalance() {
  const usdc = new ethers.Contract(await vaultUSDC(), erc20Abi, provider);
  const raw = await usdc.balanceOf(VAULT_ADDRESS);
  return Number(ethers.formatUnits(raw, 6));
}

// Fetch token quote from router
async function quote(routerAddr, token, amountUSDC) {
  const router = new ethers.Contract(
    routerAddr,
    ["function getAmountsOut(uint,address[]) view returns(uint[])"],
    provider
  );
  const amt = ethers.parseUnits(amountUSDC.toString(), 6);
  for (const base of BASES) {
    try {
      const a = await router.getAmountsOut(amt, [base, token.address]);
      return Number(ethers.formatUnits(a[1], token.decimals));
    } catch {}
  }
  return null;
}

// ----------------- SMART AUTO-APPROVE -----------------
async function ensureApprovals() {
  const usdcAddr = await vaultUSDC();
  console.log(`${colors.cyan}🔑 Checking router approvals...${colors.reset}`);

  for (const token of Object.values(tokens)) {
    const tokenContract = new ethers.Contract(token.address, erc20Abi, wallet);

    for (const router of Object.values(routers)) {
      try {
        const allowance = await tokenContract.allowance(VAULT_ADDRESS, router);
        // ethers v6 returns bigint
        if (allowance > ethers.parseUnits("1000000", token.decimals)) {
          continue; // already approved
        }

        const tx = await vault.approveRouter(router, token.address);
        console.log(`${colors.green}✅ Approval sent for ${token.address} -> ${router}${colors.reset}`);
        if (!DRY_RUN) await tx.wait();
      } catch (e) {
        console.log(`${colors.red}⚠️ Approval error: ${e.message}${colors.reset}`);
      }
      await sleep(200);
    }
  }
}

// ----------------- EXECUTION -----------------
async function executeTrade(buyRouter, sellRouter, token, amountUSDC) {
  try {
    const before = await vaultBalance();
    console.log(`${colors.cyan}🏦 Vault Before: ${fmt(before)} USDC${colors.reset}`);

    if (before < amountUSDC) {
      console.log(`${colors.red}❌ Vault insufficient USDC${colors.reset}`);
      return;
    }

    const buyOut = await quote(buyRouter, token, amountUSDC);
    const sellOut = await quote(sellRouter, token, amountUSDC);
    if (!buyOut || !sellOut) return;

    const buyPrice = amountUSDC / buyOut;
    const sellPrice = amountUSDC / sellOut;
    const profit = (sellPrice - buyPrice) * (1 - SLIPPAGE_PCT / 100);
    const pct = (profit / buyPrice) * 100;

    if (!sanePct(pct) || profit < MIN_EXPECTED_PROFIT || pct < MIN_PROFIT_PCT) {
      console.log(`${colors.yellow}⚠️ Profit too low${colors.reset}`);
      return;
    }

    console.log(`${colors.green}💰 Expected Profit: ${fmt(profit)} USDC (${fmt(pct)}%)${colors.reset}`);
    console.log(`${colors.cyan}📈 Buy: ${fmt(buyPrice)}, Sell: ${fmt(sellPrice)}${colors.reset}`);

    if (DRY_RUN) {
      console.log(`${colors.magenta}🔎 DRY RUN${colors.reset}`);
      return;
    }

    const minTokenOut = Math.floor(buyOut * (1 - SLIPPAGE_PCT / 100));
    const minUSDCOut = Math.floor(sellOut * (1 - SLIPPAGE_PCT / 100));

    const tx = await vault.executeArbitrage(
      buyRouter,
      sellRouter,
      token.address,
      ethers.parseUnits(amountUSDC.toString(), 6),
      minTokenOut,
      minUSDCOut,
      Math.floor(Date.now() / 1000) + 120
    ).catch(e => {
      console.log(`${colors.red}⚠️ Tx rejected: ${e.reason || e.message}${colors.reset}`);
      return null;
    });

    if (!tx) return;

    console.log(`${colors.green}🔁 TX SENT: ${tx.hash}${colors.reset}`);
    const receipt = await tx.wait().catch(() => null);
    if (!receipt || receipt.status !== 1) return;

    const after = await vaultBalance();
    console.log(`${colors.green}✅ Vault After: ${fmt(after)} USDC, REAL PROFIT: ${fmt(after - before)} USDC${colors.reset}`);

  } catch (err) {
    console.log(`${colors.red}⚠️ Trade error: ${err.message}${colors.reset}`);
  }
}

// ----------------- SCANNER -----------------
async function scan() {
  console.log("\n🔍 Scanning...");
  for (const token of Object.values(tokens)) {
    for (const buy of Object.values(routers)) {
      for (const sell of Object.values(routers)) {
        if (buy === sell) continue;
        await executeTrade(buy, sell, token, MIN_TRADE_USDC);
        await sleep(800);
      }
    }
  }
}

// ----------------- MAIN -----------------
(async () => {
  console.log(`${colors.cyan}🚀 Arb bot running${colors.reset}`);

  await ensureApprovals(); // auto-approve only if needed

  while (true) {
    try {
      await scan();
    } catch (e) {
      console.log(`${colors.red}⚠️ Scanner error: ${e.message}${colors.reset}`);
    }
    await sleep(8000);
  }
})();
