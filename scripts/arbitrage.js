import { ethers } from "ethers";
import arbArtifact from "../artifacts/contracts/Arbitrage.sol/Arbitrage.json" assert { type: "json" };

// === CONFIG ===
const RPC_URL = "https://polygon-rpc.com";
const provider = new ethers.JsonRpcProvider(RPC_URL);

const PRIVATE_KEY = process.env.PRIVATE_KEY;
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// === CONTRACT ===
const CONTRACT_ADDRESS = "0xYOUR_ARBITRAGE_CONTRACT";
const arbContract = new ethers.Contract(CONTRACT_ADDRESS, arbArtifact.abi, wallet);

// === TOKENS ===
const tokens = {
  USDC: { address: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", decimals: 6 },
  WETH: { address: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", decimals: 18 },
  USDT: { address: "0xc2132D05D31c914a87C6611C10748AaCbFf7c3AD", decimals: 6 },
  DAI:  { address: "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063", decimals: 18 },
};

// === ROUTERS ===
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506",
  Dfyn:      "0xA102072A4C07F06EC3B4900FDC4C7B80b6c57429",
  ApeSwap:   "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607",
};

// Normalize all addresses to checksum form (fix bad checksum errors)
for (const key in routers) routers[key] = ethers.getAddress(routers[key]);
for (const key in tokens) tokens[key].address = ethers.getAddress(tokens[key].address);

const USDC = new ethers.Contract(tokens.USDC.address, [
  "function balanceOf(address) view returns (uint256)"
], provider);

// === CORE LOGIC ===
const TRADE_AMOUNT = "100"; // in USDC

async function executeTrade(buyRouter, sellRouter, tokenAddr) {
  try {
    const amountIn = ethers.parseUnits(TRADE_AMOUNT, tokens.USDC.decimals);

    // Simulate (no gas) to avoid reverted txs
    await arbContract.callStatic.executeArbitrage(buyRouter, sellRouter, tokenAddr, amountIn);

    // Real trade (only runs if simulation passed)
    const balBefore = await USDC.balanceOf(CONTRACT_ADDRESS);
    const tx = await arbContract.executeArbitrage(buyRouter, sellRouter, tokenAddr, amountIn, {
      gasLimit: 1_500_000,
    });
    console.log(`🚀 Executing trade: ${buyRouter} → ${sellRouter} (${tokenAddr})`);
    const receipt = await tx.wait();

    // Check contract balance growth
    const balAfter = await USDC.balanceOf(CONTRACT_ADDRESS);
    const profit = balAfter - balBefore;
    const profitFmt = Number(ethers.formatUnits(profit, tokens.USDC.decimals));

    if (profitFmt > 0) {
      console.log(`✅ Profit deposited: ${profitFmt.toFixed(4)} USDC`);
    } else {
      console.log(`⚠️ Trade executed but no net profit.`);
    }

    console.log(`🔗 Tx hash: ${receipt.hash}`);
  } catch (err) {
    console.warn(`❌ Trade skipped/reverted: ${err.message}`);
  }
}

// === MAIN LOOP ===
async function main() {
  console.log("Starting arbitrage scan...");

  const tokenKeys = Object.keys(tokens).filter((t) => t !== "USDC");
  const routerKeys = Object.keys(routers);

  for (const tokenKey of tokenKeys) {
    const token = tokens[tokenKey];

    for (const buy of routerKeys) {
      for (const sell of routerKeys) {
        if (buy === sell) continue;

        console.log(`Scanning ${tokenKey}: ${buy} → ${sell}`);

        await executeTrade(routers[buy], routers[sell], token.address);
      }
    }
  }

  console.log("✅ Arbitrage scan complete.");
}

main().catch(console.error);
