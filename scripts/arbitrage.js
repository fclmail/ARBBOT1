import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

// ─────────────── CONFIG ───────────────
const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) throw new Error("Missing PRIVATE_KEY");

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

const CONTRACT_ADDRESS = "0x19b64f74553ee0ee26ba01bf34321735e4701c43";
const arbContract = new ethers.Contract(
  CONTRACT_ADDRESS,
  [
    "function executeArbitrage(address buyRouter, address sellRouter, address token, uint256 amountIn) external"
  ],
  wallet
);

// ─────────────── ROUTERS ───────────────
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  Dfyn: "0xA8b607Aa09B6A2641cF6F90f643E76d3f6e6Ff73",
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607"
};

// ─────────────── TOKENS ───────────────
const tokens = {
   AAVE:{address:"0xd6df932a45c0f255f85145f286ea0b292b21c90b",decimals:18},
      APE:{address:"0x4d224452801aced8b2f0aebe155379bb5d594381",decimals:18},
      AXLUSDC:{address:"0x2a2b6055a5c6945f4fe0e814f5d4a13b5a681159",decimals:6},
      BETA:{address:"0x0afaabcad8815b32bf2b64e0dc5e1df2f1454cde",decimals:18},
      BONE:{address:"0xad37e3433ebde20e5fbf531e6c7da1655c60bb8e",decimals:18},
      CRV:{address:"0x172370d5cd63279efa6d502dab29171933a610af",decimals:18},
      DAI:{address:"0x8f3cf7ad23cd3cadbd9735aff958023239c6a063",decimals:18},
      DPI:{address:"0x1494ca1f11d487c2bbe4543e90080aeba4ba3c2b",decimals:18},
      FND:{address:"0x292c4eefdda27062049d44d4730d5fe774b5f4c7",decimals:18},
      FREE:{address:"0xe1ae4d4a3a2200ae5ac06e50bca0dd7e52a19238",decimals:18},
      KLIMA:{address:"0x4e78011ce80ee02d2c3e649fb657e45898257815",decimals:9},
      LDO:{address:"0xbb0bb78beeea5cf201b8f2651f48830e64ce45a4",decimals:18},
      LINK:{address:"0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39",decimals:18},
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
      WETH:{address:"0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",decimals:18},
      XSGD:{address:"0x70e8de73ce022f373d5a9f00b0ec0cf5835b0fc0",decimals:6}
  // Add more tokens as in HTML if needed
};

// ─────────────── TRADE SETTINGS ───────────────
const TRADE_AMOUNT_USDC = .10; // trade amount in USDC
const MIN_PROFIT_PCT = 0.2; // minimum profit %
const SLIPPAGE_PCT = 0; // adjust like HTML

// ─────────────── HELPERS ───────────────
function fmt(n, dec = 6) {
  return Number(n).toFixed(dec);
}

async function getAmountOut(routerAddr, token, amountIn) {
  const router = new ethers.Contract(
    routerAddr,
    ["function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory)"],
    provider
  );

  const path = [tokens.USDC.address, token.address];
  let out;

  try {
    const amounts = await router.getAmountsOut(
      ethers.parseUnits(amountIn.toString(), tokens.USDC.decimals),
      path
    );
    out = Number(ethers.formatUnits(amounts[amounts.length - 1], token.decimals));
  } catch {
    // fallback via WETH
    const path2 = [tokens.USDC.address, tokens.WETH.address, token.address];
    const amounts = await router.getAmountsOut(
      ethers.parseUnits(amountIn.toString(), tokens.USDC.decimals),
      path2
    );
    out = Number(ethers.formatUnits(amounts[amounts.length - 1], token.decimals));
  }

  return out;
}

// ─────────────── SCAN LOOP ───────────────
async function scan() {
  console.log("Starting arbitrage scan...");
  const opportunities = [];

  for (const [symbol, token] of Object.entries(tokens)) {
    for (const [buyName, buyRouter] of Object.entries(routers)) {
      for (const [sellName, sellRouter] of Object.entries(routers)) {
        if (buyName === sellName) continue;

        try {
          const buyOut = await getAmountOut(buyRouter, token, TRADE_AMOUNT_USDC);
          const sellOut = await getAmountOut(sellRouter, token, TRADE_AMOUNT_USDC);

          // Profit calculation matches HTML
          const buyPrice = TRADE_AMOUNT_USDC / buyOut;
          const sellPrice = TRADE_AMOUNT_USDC / sellOut;
          let profitUSDC = sellPrice - buyPrice;
          let profitPct = (profitUSDC / buyPrice) * 100;

          // Apply slippage
          const slAdj = 1 - SLIPPAGE_PCT / 100;
          profitUSDC *= slAdj;
          profitPct *= slAdj;

         if (profitPct >= MIN_PROFIT_PCT) {
  opportunities.push({ token: symbol, buyName, sellName, buyPrice, sellPrice, profitUSDC, profitPct });
  console.log(
    `🚨 ${symbol} | Buy:${buyName} Sell:${sellName} Profit: $${fmt(profitUSDC)} (${fmt(profitPct, 2)}%)`
  );

  try {
    // ✅ Execute trade automatically with checksummed addresses
    await executeTrade(
      ethers.getAddress(buyRouter),
      ethers.getAddress(sellRouter),
      ethers.getAddress(token.address),
      TRADE_AMOUNT_USDC
    );
  } catch (err) {
    console.warn(`⚠️ Failed to execute trade: ${err.message}`);
  }
}

        } catch (e) {
          console.warn(`⚠️ Error ${symbol} ${buyName}->${sellName}: ${e.message}`);
        }
      }
    }
  }

  console.log(`Scan complete. Found ${opportunities.length} opportunities.`);
  return opportunities;
}

// ─────────────── EXECUTE TRADE ───────────────
async function executeTrade(buyRouter, sellRouter, tokenAddr, amount) {
  try {
    const tx = await arbContract.executeArbitrage(
      buyRouter,
      sellRouter,
      tokenAddr,
      ethers.parseUnits(amount.toString(), tokens.USDC.decimals),
      { gasLimit: 1_500_000 }
    );
    console.log(`✅ Trade executed: ${tx.hash}`);
    await tx.wait();
  } catch (e) {
    console.error(`⚠️ Trade failed: ${e.message}`);
  }
}

// ─────────────── START ───────────────
async function main() {
  while (true) {
    await scan();
    await new Promise((r) => setTimeout(r, 3000)); // scan every 3 s
  }
}

main().catch(console.error);
