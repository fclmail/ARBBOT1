import dotenv from "dotenv";
import { ethers } from "ethers";
dotenv.config();

/* ================= SAFETY ================= */
process.on("unhandledRejection", e => console.log("⚠️", e?.message || e));
process.on("uncaughtException", e => console.log("⚠️", e.message));
/* ========================================= */

const RPC = process.env.RPC_URL;
const PK  = process.env.PRIVATE_KEY || process.env.WALLET_PRIVATE_KEY;

const VAULT = "0x04b0d378cfDD6F2F3895E19ACDc411a4558F875A";
const USDC  = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"; // USDCe

const provider = new ethers.JsonRpcProvider(RPC);
const wallet   = new ethers.Wallet(PK, provider);

const vaultAbi = [
  "function executeArbitrage(address,address,address,uint256,uint256,uint256,uint256)",
  "function USDC() view returns(address)"
];

const erc20Abi = [
  "function balanceOf(address) view returns(uint256)"
];

const vault = new ethers.Contract(VAULT, vaultAbi, wallet);
const usdc  = new ethers.Contract(USDC, erc20Abi, provider);

/* -------- ROUTERS (same ones your arbjs1 uses) -------- */
const routers = {
  Quick: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  Sushi: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506"
};

const TOKEN = "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39"; // LINK example
const TRADE = ethers.parseUnits("0.05", 6); // 0.05 USDCe

/* ---------------- HELPERS ---------------- */

const fmt = n => Number(n).toFixed(6);

async function vaultBalance() {
  const bal = await usdc.balanceOf(VAULT);
  return Number(ethers.formatUnits(bal, 6));
}

async function matic() {
  const bal = await provider.getBalance(wallet.address);
  return Number(ethers.formatEther(bal));
}

/* ---------------- MAIN LOOP ---------------- */

console.log("🚀 ARBjs-2 Fire-Every-5s Engine Started");

async function fire() {
  try {
    const before = await vaultBalance();
    const m0 = await matic();

    console.log(`\n⏱ ${new Date().toLocaleTimeString()}`);
    console.log(`🏦 Vault before: ${fmt(before)} USDCe | ⛽ MATIC: ${fmt(m0,4)}`);

    const tx = await vault.executeArbitrage(
      routers.Quick,
      routers.Sushi,
      TOKEN,
      TRADE,
      0,
      0,
      Math.floor(Date.now() / 1000) + 120,
      { gasLimit: 700000 }
    );

    console.log("📤 TX sent:", tx.hash);

    const r = await tx.wait();

    if (r.status !== 1) {
      console.log("🔴 TX reverted");
      return;
    }

    const after = await vaultBalance();
    const m1 = await matic();

    console.log(`🟢 SUCCESS`);
    console.log(`🏦 Vault after : ${fmt(after)} USDCe`);
    console.log(`💰 PROFIT     : ${fmt(after - before)} USDCe`);
    console.log(`⛽ MATIC left : ${fmt(m1,4)}`);

  } catch (e) {
    // This is what you will see MOST of the time (not profitable)
    console.log("🔴 REVERT:", e.reason || e.message);
  }
}

/* ------------- RUN EVERY 5 SECONDS ------------- */
setInterval(fire, 5000);
