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
  "function balanceOf(address) view returns(uint256)"
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

const TOKEN = "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6"; // LINK
const TRADE = ethers.parseUnits("100.12", 6);

/* ----------------- HELPERS ----------------- */
const fmt = n => Number(n).toFixed(6);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function vaultBalance() {
  return Number(ethers.formatUnits(await usdc.balanceOf(VAULT), 6));
}

/* ----------------- NONCE LOCK ----------------- */
let lockedNonce = null;

async function getNonce() {
  if (lockedNonce === null) {
    lockedNonce = await provider.getTransactionCount(wallet.address, "pending");
  }
  return lockedNonce;
}

/* ----------------- MAIN LOOP ----------------- */

console.log("🚀 ARBjs PRO — simulation + nonce + gas safe");

async function tick() {
  try {
    const before = await vaultBalance();
    const nonce = await getNonce();

    console.log(`\n⏱ ${new Date().toLocaleTimeString()}`);
    console.log(`🏦 Vault: ${fmt(before)} USDCe`);

    /* ========== 1) STATIC SIMULATION (0 GAS) ========== */
    try {
      await vault.executeArbitrage.staticCall(
        routers.Quick,
        routers.Sushi,
        TOKEN,
        TRADE,
        0,
        0,
        Math.floor(Date.now() / 1000) + 120
      );
    } catch {
      console.log("⏭ Not profitable — skipped (0 gas)");
      return;
    }

    console.log("🟢 Simulation passed — sending transaction");

    /* ========== 2) GAS-SAFE SEND ========== */
    const fee = await provider.getFeeData();

    const tx = await vault.executeArbitrage(
      routers.Quick,
      routers.Sushi,
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
      console.log("🔴 On-chain revert");
      return;
    }

    const after = await vaultBalance();

    console.log("🟢 SUCCESS");
    console.log(`💰 PROFIT: ${fmt(after - before)} USDCe`);
    console.log(`🏦 Vault : ${fmt(after)} USDCe`);

  } catch (e) {
    console.log("⚠️", e.message);
  }
}

/* ----------------- RUN FOREVER ----------------- */
while (true) {
  await tick();
  await sleep(5000);
}
