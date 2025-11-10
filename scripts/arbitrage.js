// ─────────────── IMPORTS ───────────────
import { ethers } from "ethers";
import dotenv from "dotenv";
import arbArtifact from "../artifacts/contracts/AaveFlashArb.sol/AaveFlashArb.json" assert { type: "json" };
dotenv.config();

// ─────────────── CONFIG ───────────────
const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) throw new Error("Missing PRIVATE_KEY in .env");

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// ✅ Your deployed contract address (update if redeployed)
const CONTRACT_ADDRESS = "0x19b64f74553ee0ee26ba01bf34321735e4701c43";

// ─────────────── CONTRACT ───────────────
const arbContract = new ethers.Contract(CONTRACT_ADDRESS, arbArtifact.abi, wallet);

// ─────────────── ROUTERS ───────────────
const routers = {
  QuickSwap: ethers.getAddress("0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff"),
  SushiSwap: ethers.getAddress("0x1b02dA8Cb0d097eb8D57a175b88c7D8b47997506"),
  Dfyn: ethers.getAddress("0xA8b607Aa09B6A2641cF6F90f643E76d3f6e6Ff73"),
  ApeSwap: ethers.getAddress("0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607")
};

// ─────────────── TOKENS ───────────────
const tokens = {
  AAVE:  { address: ethers.getAddress("0xd6df932a45c0f255f85145f286ea0b292b21c90b"), decimals: 18 },
  CRV:   { address: ethers.getAddress("0x172370d5cd63279efa6d502dab29171933a610af"), decimals: 18 },
  DAI:   { address: ethers.getAddress("0x8f3cf7ad23cd3cadbd9735aff958023239c6a063"), decimals: 18 },
  KLIMA: { address: ethers.getAddress("0x4e78011ce80ee02d2c3e649fb657e45898257815"), decimals: 9 },
  LINK:  { address: ethers.getAddress("0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39"), decimals: 18 },
  QUICK: { address: ethers.getAddress("0x831753dd7087cac61ab5644b308642cc1c33dc13"), decimals: 18 },
  UNI:   { address: ethers.getAddress("0x1f9840a85d5af5bf1d1762f925bdaddc4201f984"), decimals: 18 },
  UNI2:  { address: ethers.getAddress("0xb33eaad8d922b1083446dc23f610c2567fb5180f"), decimals: 18 },
  USDC:  { address: ethers.getAddress("0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"), decimals: 6 },
  USDT:  { address: ethers.getAddress("0xC2132D05D31c914A87C6611C10748AEb04B58e8F"), decimals: 6 },
  WBTC:  { address: ethers.getAddress("0x1BFD67037B42Cf73acf2047067bd4f2C47D9BfD6"), decimals: 8 },
  WETH:  { address: ethers.getAddress("0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619"), decimals: 18 }
};

// ─────────────── TRADE SETTINGS ───────────────
const TRADE_AMOUNT_USDC = 10;   // USDC amount to test each arb
const MIN_PROFIT_PCT = 5;       // only execute >5% profit
const SLIPPAGE_PCT = 0;         // simulate 0% slippage

// ─────────────── HELPERS ───────────────
function fmt(n, dec = 4) {
  return Number(n).toFixed(dec);
}

async function getAmountOut(routerAddr, token, amountIn) {
  const router = new ethers.Contract(
    routerAddr,
    ["function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory)"],
    provider
  );
  try {
    const path = [tokens.USDC.address, token.address];
    const amounts = await router.getAmountsOut(
      ethers.parseUnits(amountIn.toString(), tokens.USDC.decimals),
      path
    );
    return Number(ethers.formatUnits(amounts[amounts.length - 1], token.decimals));
  } catch {
    const path = [tokens.USDC.address, tokens.WETH.address, token.address];
    const amounts = await router.getAmountsOut(
      ethers.parseUnits(amountIn.toString(), tokens.USDC.decimals),
      path
    );
    return Number(ethers.formatUnits(amounts[amounts.length - 1], token.decimals));
  }
}

// ─────────────── EXECUTION LOGIC ───────────────
async function executeTrade(buyRouter, sellRouter, tokenAddr, amountUSDC) {
  try {
    console.log(`🚀 Executing arbitrage...`);
    const tx = await arbContract.executeArbitrage(
      buyRouter,
      sellRouter,
      tokenAddr,
      ethers.parseUnits(amountUSDC.toString(), tokens.USDC.decimals),
      { gasLimit: 1_500_000 }
    );
    console.log(`⏳ TX submitted: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`✅ Trade confirmed in block ${receipt.blockNumber}`);

    const bal = await new ethers.Contract(tokens.USDC.address, ["function balanceOf(address) view returns (uint256)"], provider)
      .balanceOf(CONTRACT_ADDRESS);
    console.log(`💰 Contract USDC balance: ${ethers.formatUnits(bal, 6)} USDC`);
  } catch (e) {
    console.error(`⚠️ Trade failed: ${e.message}`);
  }
}

// ─────────────── MAIN SCAN LOOP ───────────────
async function scan() {
  console.log("🔍 Starting arbitrage scan...");
  for (const [symbol, token] of Object.entries(tokens)) {
    for (const [buyName, buyRouter] of Object.entries(routers)) {
      for (const [sellName, sellRouter] of Object.entries(routers)) {
        if (buyName === sellName) continue;
        try {
          const buyOut = await getAmountOut(buyRouter, token, TRADE_AMOUNT_USDC);
          const sellOut = await getAmountOut(sellRouter, token, TRADE_AMOUNT_USDC);
          const buyPrice = TRADE_AMOUNT_USDC / buyOut;
          const sellPrice = TRADE_AMOUNT_USDC / sellOut;
          let profitPct = ((sellPrice - buyPrice) / buyPrice) * 100 * (1 - SLIPPAGE_PCT / 100);

          if (profitPct >= MIN_PROFIT_PCT) {
            console.log(
              `🚨 ${symbol} | Buy:${buyName} → Sell:${sellName} | Profit: ${fmt(profitPct, 2)}%`
            );
            await executeTrade(buyRouter, sellRouter, token.address, TRADE_AMOUNT_USDC);
          }
        } catch (err) {
          console.warn(`⚠️ Error ${symbol} ${buyName}->${sellName}: ${err.message}`);
        }
      }
    }
  }
}

// ─────────────── LOOP ───────────────
async function main() {
  while (true) {
    await scan();
    await new Promise((r) => setTimeout(r, 5000)); // every 5s
  }
}

main().catch(console.error);
