import dotenv from "dotenv";
import { ethers } from "ethers";
dotenv.config();

/* ================= SAFETY ================= */
process.on("unhandledRejection", e => console.log("⚠️", e?.message || e));
process.on("uncaughtException", e => console.log("⚠️", e.message));
/* ========================================= */

const RPC = process.env.RPC_URL;
const PK  = process.env.PRIVATE_KEY || process.env.WALLET_PRIVATE_KEY;

/* ----------------- CONTRACTS ----------------- */
const VAULT = "0x04b0d378cfDD6F2F3895E19ACDc411a4558F875A";
const USDC  = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"; // USDCe

const vaultAbi = [
  "function executeArbitrage(address,address,address,uint256,uint256,uint256,uint256)"
];

const erc20Abi = [
  "function balanceOf(address) view returns(uint256)",
  "function decimals() view returns(uint8)"
];

/* ----------------- NETWORK ----------------- */
const provider = new ethers.JsonRpcProvider(RPC);
const wallet   = new ethers.Wallet(PK, provider);
const vault    = new ethers.Contract(VAULT, vaultAbi, wallet);
const usdc     = new ethers.Contract(USDC, erc20Abi, provider);

/* ----------------- ROUTERS ----------------- */
const routers = {
  Quick: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607",
  Sushi: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506"
};

/* ----------------- TOKEN ----------------- */
const TOKEN = "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6"; // LINK
const TRADE = ethers.parseUnits("100.12", 6);

/* ----------------- HELPERS ----------------- */
const fmt = (n, d = 6) => Number(n).toFixed(d);
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ----------------- NONCE LOCK ----------------- */
let lockedNonce = null;
async function getNonce() {
  if (lockedNonce === null) {
    lockedNonce = await provider.getTransactionCount(wallet.address, "pending");
  }
  return lockedNonce;
}

/* ----------------- BALANCES ----------------- */
async function vaultBalance() {
  return Number(ethers.formatUnits(await usdc.balanceOf(VAULT), 6));
}

async function walletMatic() {
  return Number(ethers.formatEther(await provider.getBalance(wallet.address)));
}

/* ----------------- PRICE LOGIC (HTML STYLE) ----------------- */
async function quoteArb(buyRouter, sellRouter, token, amountInUSDC) {
  const routerAbi = [
    "function getAmountsOut(uint amountIn, address[] memory path) view returns(uint[] memory)"
  ];

  const buyRouterC  = new ethers.Contract(buyRouter, routerAbi, provider);
  const sellRouterC = new ethers.Contract(sellRouter, routerAbi, provider);

  // BUY: USDC → TOKEN
  const buyPath = [USDC, token];
  const buyAmounts = await buyRouterC.getAmountsOut(amountInUSDC, buyPath);
  const tokenOut = buyAmounts[1];

  // SELL: TOKEN → USDC
  const sellPath = [token, USDC];
  const sellAmounts = await sellRouterC.getAmountsOut(tokenOut, sellPath);
  const usdcBack = sellAmounts[1];

  return { tokenOut, usdcBack };
}

/* ----------------- MAIN LOOP ----------------- */
console.log("🚀 ARBjs PRO — RAW opportunity scanner (HTML pricing logic)");

async function tick() {
  try {
    const beforeVault = await vaultBalance();
    const maticBal = await walletMatic();
    const nonce = await getNonce();

    console.log(`\n⏱ ${new Date().toLocaleTimeString()}`);
    console.log(`👛 Wallet MATIC: ${fmt(maticBal, 4)}`);
    console.log(`🏦 Vault USDC : ${fmt(beforeVault, 6)}`);

    for (const [buyName, buyRouter] of Object.entries(routers)) {
      for (const [sellName, sellRouter] of Object.entries(routers)) {
        if (buyName === sellName) continue;

        try {
          /* ---------- PRICE FETCH (RAW) ---------- */
          const { usdcBack } = await quoteArb(
            buyRouter,
            sellRouter,
            TOKEN,
            TRADE
          );

          const usdcIn  = Number(ethers.formatUnits(TRADE, 6));
          const usdcOut = Number(ethers.formatUnits(usdcBack, 6));

          const profitUSDC = usdcOut - usdcIn;
          const profitPct  = (profitUSDC / usdcIn) * 100;

          console.log(
            `🔎 ${buyName} → ${sellName} | BUY: ${fmt(usdcIn)} | SELL: ${fmt(usdcOut)} | PROFIT: ${fmt(profitUSDC)} (${fmt(profitPct,2)}%)`
          );

          /* ---------- STATIC SAFETY (0 GAS) ---------- */
          try {
            await vault.executeArbitrage.staticCall(
              buyRouter,
              sellRouter,
              TOKEN,
              TRADE,
              0,
              0,
              Math.floor(Date.now() / 1000) + 120
            );
          } catch {
            continue; // NO_PROFIT or router revert
          }

          /* ---------- SEND TX ---------- */
          console.log("🟢 Simulation passed — executing");

          const fee = await provider.getFeeData();
          const tx = await vault.executeArbitrage(
            buyRouter,
            sellRouter,
            TOKEN,
            TRADE,
            0,
            0,
            Math.floor(Date.now() / 1000) + 120,
            {
              nonce,
              gasLimit: 700000,
              maxFeePerGas: fee.maxFeePerGas * 12n / 10n,
              maxPriorityFeePerGas: fee.maxPriorityFeePerGas * 12n / 10n
            }
          );

          console.log("📤 TX:", tx.hash);

          const r = await tx.wait();
          lockedNonce++;

          if (r.status !== 1) {
            console.log("🔴 Reverted on-chain");
            continue;
          }

          const afterVault = await vaultBalance();
          console.log("🟢 SUCCESS");
          console.log(`💰 PROFIT: ${fmt(afterVault - beforeVault)} USDC`);
          console.log(`🏦 Vault : ${fmt(afterVault)} USDC`);

        } catch (e) {
          console.log(`⚠️ ${buyName} → ${sellName}: ${e.message}`);
        }
      }
    }

  } catch (e) {
    console.log("⚠️", e.message);
  }
}

/* ----------------- RUN FOREVER ----------------- */
while (true) {
  await tick();
  await sleep(5000);
}
