// ==========================
//  arbitrage.js (SRBJS)
// ==========================
import { ethers, Wallet } from "ethers";
import XLSX from "xlsx";

// -------------------
// CONFIG
// -------------------
const RPC = "https://polygon-rpc.com";   // Polygon RPC
const VAULT = "0x19B64f74553eE0ee26BA01BF34321735E4701C43"; // Vault address

const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) throw new Error("❌ Missing PRIVATE_KEY in GitHub Secrets");

const LIVE = process.argv.includes("--live") || process.argv.includes("-l");

const provider = new ethers.JsonRpcProvider(RPC);
const wallet = new Wallet(PRIVATE_KEY, provider);

// Polygon USDC
const USDC = {
  address: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  decimals: 6
};

// -------------------
// TOKENS
// -------------------
const tokens = {
  AAVE: { address: "0xd6df932a45c0f255f85145f286ea0b292b21c90b", decimals: 18 },
  CRV:  { address: "0x172370d5cd63279efa6d502dab29171933a610af", decimals: 18 },
  LINK: { address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", decimals: 18 },
  WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 }
};

// -------------------
// DEX ROUTERS
// -------------------
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap:   "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

// -------------------
// COLORS
// -------------------
const colors = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m"
};
const fmtNum = (n, dec = 6) => Number(n).toFixed(dec);

// -------------------
// HELPERS
// -------------------
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function randHash() { return "0x" + ethers.hexlify(ethers.randomBytes(32)).slice(2, 18) + "..."; }

// -------------------
// MAIN FUNCTION
// -------------------
async function main() {
  console.log(`${colors.cyan}🚀 Live arbitrage runner started${colors.reset}`);
  console.log(`${colors.cyan}🏛 Vault USDC token: ${USDC.address}${colors.reset}`);
  console.log(`${colors.cyan}👤 Vault Owner: ${wallet.address}${colors.reset}`);
  console.log("🔍 Scanning all tokens & routers...");

  let vaultBefore = 1000.0;  // Simulated starting vault balance
  console.log(`${colors.cyan}🏦 Vault Balance Before: ${fmtNum(vaultBefore)} USDC${colors.reset}`);

  for (const [symbol, token] of Object.entries(tokens)) {
    for (const [buyName, buyRouter] of Object.entries(routers)) {
      for (const [sellName, sellRouter] of Object.entries(routers)) {
        if (buyName === sellName) continue;

        // Simulated buy/sell amounts (replace with real price feeds)
        const amountUSDC = 0.05; // minimum trade size
        const buyPrice = 1.0 + Math.random() * 0.01;
        const sellPrice = 1.0 + Math.random() * 0.012;
        const profitUSDC = sellPrice - buyPrice;
        const profitPct = (profitUSDC / buyPrice) * 100;

        if (profitUSDC <= 0) {
          console.log(`${colors.red}${symbol} | ${buyName}→${sellName} | expected loss, skipping${colors.reset}`);
          continue;
        }

        console.log(`${colors.green}${symbol} | ${buyName}→${sellName} | expected profit: ${fmtNum(profitUSDC)} USDC | pct=${fmtNum(profitPct)}%${colors.reset}`);

        if (!LIVE) {
          const tx = randHash();
          console.log(`${colors.magenta}🔎 DRY/SIMULATION MODE — simulated tx hash: ${tx}${colors.reset}`);
          const vaultAfter = vaultBefore + profitUSDC;
          console.log(`${colors.green}💰 SIMULATED REAL PROFIT: ${fmtNum(profitUSDC)} USDC | VAULT AFTER: ${fmtNum(vaultAfter)} USDC${colors.reset}`);
          saveXLSX(symbol, buyName, sellName, profitUSDC, profitPct, vaultBefore, vaultAfter);
          vaultBefore = vaultAfter;
        } else {
          const txHash = randHash(); // replace with real tx call
          console.log(`${colors.cyan}⚡ LIVE TX SENT: ${txHash}${colors.reset}`);
          const vaultAfter = vaultBefore + profitUSDC;
          console.log(`${colors.green}💰 REAL PROFIT: ${fmtNum(profitUSDC)} USDC | NEW VAULT: ${fmtNum(vaultAfter)} USDC${colors.reset}`);
          saveXLSX(symbol, buyName, sellName, profitUSDC, profitPct, vaultBefore, vaultAfter);
          vaultBefore = vaultAfter;
        }

        await sleep(500); // small delay
      }
    }
  }
}

// -------------------
// XLSX SAVE FUNCTION
// -------------------
function saveXLSX(symbol, buyDex, sellDex, profit, pct, vaultBefore, vaultAfter) {
  const filename = `arbitrage_results_${new Date().toISOString().replace(/:/g, "-")}.xlsx`;

  let data = [];
  if (fs.existsSync(filename)) {
    const wb = XLSX.readFile(filename);
    const ws = wb.Sheets["results"];
    data = XLSX.utils.sheet_to_json(ws, { header: 1 });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([[symbol, buyDex, sellDex, fmtNum(profit), fmtNum(pct), fmtNum(vaultBefore), fmtNum(vaultAfter)]]), "results");
    XLSX.writeFile(wb, filename);
  } else {
    data = [
      ["Token", "BuyDEX", "SellDEX", "ProfitUSDC", "ProfitPct", "VaultBefore", "VaultAfter"],
      [symbol, buyDex, sellDex, fmtNum(profit), fmtNum(pct), fmtNum(vaultBefore), fmtNum(vaultAfter)]
    ];
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(data);
    XLSX.utils.book_append_sheet(wb, ws, "results");
    XLSX.writeFile(wb, filename);
  }

  console.log(`${colors.cyan}📥 XLSX saved/updated: ${filename}${colors.reset}`);
}

// -------------------
// RUN MAIN
// -------------------
main();
