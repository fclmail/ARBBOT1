#!/usr/bin/env node
/**
 * Full arbitrage scanner (getAmountsOut-based profit)
 * - Scans all tokens across routers (Dfyn, ApeSwap)
 * - Computes raw profit using getAmountsOut only (no callStatic)
 * - Logs buy price, sell price and profit in USDC ($) format
 * - Executes arbitrage if profit >= MIN_PROFIT_USDC
 *
 * Note: Requires RPC_URL and PRIVATE_KEY in environment.
 */

import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

// ---------- CONFIG ----------
const RPC_URL = process.env.RPC_URL || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) {
  console.error("❌ Missing PRIVATE_KEY in environment");
  process.exit(1);
}

// Hardcoded arbitrage contract (owner-only executeArbitrage)
const CONTRACT_ADDRESS = "0x19B64f74553eE0ee26BA01BF34321735E4701C43".toLowerCase();

// Routers (lowercase to avoid checksum errors)
const ROUTERS = {
  Dfyn: "0xa8b607aa09b6a2641cf6f90f643e76d3f6e6ff73",     // Dfyn (lowercase)
  ApeSwap: "0xc0788a3ad43d79aa53b09c2eacc313a787d1d607"  // ApeSwap (lowercase)
};

// Factories for pair existence checks (lowercase)
const FACTORIES = {
  Dfyn: "0x9ad32efcb1c6c92f9f9701d7a1f4c964f59e7fbd",    // example factory (use the correct one if different)
  ApeSwap: "0xcf083be4164828f00cae704ec15a36d711491284"
};

// Full TOKENS list (no duplicates)
const TOKENS = {
  AAVE: { address: "0xd6df932a45c0f255f85145f286ea0b292b21c90b", decimals: 18 },
  APE: { address: "0x4d224452801aced8b2f0aebe155379bb5d594381", decimals: 18 },
  AXLUSDC: { address: "0x2a2b6055a5c6945f4fe0e814f5d4a13b5a681159", decimals: 6 },
  BETA: { address: "0x0afaabcad8815b32bf2b64e0dc5e1df2f1454cde", decimals: 18 },
  BONE: { address: "0xad37e3433ebde20e5fbf531e6c7da1655c60bb8e", decimals: 18 },
  CRV: { address: "0x172370d5cd63279efa6d502dab29171933a610af", decimals: 18 },
  DAI: { address: "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063", decimals: 18 },
  DPI: { address: "0x1494ca1f11d487c2bbe4543e90080aeba4ba3c2b", decimals: 18 },
  FND: { address: "0x292c4eefdda27062049d44d4730d5fe774b5f4c7", decimals: 18 },
  FREE: { address: "0xe1ae4d4a3a2200ae5ac06e50bca0dd7e52a19238", decimals: 18 },
  KLIMA: { address: "0x4e78011ce80ee02d2c3e649fb657e45898257815", decimals: 9 },
  LDO: { address: "0xbb0bb78beeea5cf201b8f2651f48830e64ce45a4", decimals: 18 },
  LINK: { address: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39", decimals: 18 },
  MATICX: { address: "0xa3fa99a148fa48d14ed51d610c367c61876997f1", decimals: 18 },
  OS: { address: "0xd3a691c852cdb01e281545a27064741f0b7f6825", decimals: 18 },
  QUICK: { address: "0x831753dd7087cac61ab5644b308642cc1c33dc13", decimals: 18 },
  RNDR: { address: "0x6c3c7886b43d005db8c28a09e8038b87e36cf26c", decimals: 18 },
  SHIB: { address: "0x6f8a06447ff6fcf75a5fcdb3f8c4bab2da4fc0d0", decimals: 18 },
  SHIKIGON: { address: "0x3f0fb6e42d160a8def49fe68b8ef4d8a5b7ab119", decimals: 18 },
  SURE: { address: "0xf638a9594c0c780d6c8bc40fa33efb0ceabf5d57", decimals: 18 },
  THE7: { address: "0x045f7ffdcc8334e78316a2c1164efb2e5f3815d5", decimals: 18 },
  TRADE: { address: "0x82362ec182db3cf7829014bc61e9be8a2e82868a", decimals: 18 },
  UNI: { address: "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984", decimals: 18 },
  UNI2: { address: "0xb33eaad8d922b1083446dc23f610c2567fb5180f", decimals: 18 },
  USDC: { address: "0x2791bca1f2de4661ed88a30c99a7a9449aa84174", decimals: 6 },
  USDT: { address: "0xc2132d05d31c914a87c6611c10748aeb04b58e8f", decimals: 6 },
  WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 },
  WETH: { address: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619", decimals: 18 },
  XSGD: { address: "0x70e8de73ce022f373d5a9f00b0ec0cf5835b0fc0", decimals: 6 },
};

// ---------- PARAMETERS ----------
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const arbContract = new ethers.Contract(CONTRACT_ADDRESS, [
  "function executeArbitrage(address buyRouter, address sellRouter, address token, uint256 amountIn) external"
], wallet);

const TRADE_AMOUNT_USDC = ethers.parseUnits("100", TOKENS.USDC.decimals); // $100
const MIN_PROFIT_USDC = ethers.parseUnits("0.01", TOKENS.USDC.decimals);  // $0.01
const SCAN_DELAY_MS = 600; // small throttle to reduce RPC rate limits

// ABIs
const ROUTER_ABI = ["function getAmountsOut(uint256 amountIn, address[] calldata path) view returns (uint256[] memory amounts)"];
const FACTORY_ABI = ["function getPair(address tokenA, address tokenB) external view returns (address)"];

// Helpers
const fmtUSDC = (big) => Number(ethers.formatUnits(big, TOKENS.USDC.decimals)).toFixed(6);
const now = () => new Date().toISOString();

// Build router and factory contract objects
const routers = {};
const factories = {};
for (const [name, addr] of Object.entries(ROUTERS)) {
  routers[name] = new ethers.Contract(addr, ROUTER_ABI, provider);
  const faddr = FACTORIES[name];
  if (faddr) factories[name] = new ethers.Contract(faddr, FACTORY_ABI, provider);
}

// Print header like you requested
console.log(`🔗 Contract: ${CONTRACT_ADDRESS}`);
console.log(`💰 Trade Amount: $${ethers.formatUnits(TRADE_AMOUNT_USDC, TOKENS.USDC.decimals)}`);
console.log(`📈 Min Profit: $${ethers.formatUnits(MIN_PROFIT_USDC, TOKENS.USDC.decimals)}`);
console.log(`🔧 Using Routers: ${Object.keys(ROUTERS).join(", ")}`);
console.log();

// Small utility sleep
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// Main scan loop
(async function mainLoop() {
  while (true) {
    console.log(`${now()} ▸ Scanning tokens...`);
    for (const [tokenSymbol, token] of Object.entries(TOKENS)) {
      if (tokenSymbol === "USDC") continue; // skip base

      // Loop all router pairs
      for (const [buyName, buyRouter] of Object.entries(routers)) {
        for (const [sellName, sellRouter] of Object.entries(routers)) {
          if (buyName === sellName) continue;

          // Throttle to avoid rate limits
          await sleep(SCAN_DELAY_MS);

          try {
            // Optional: check pair exists on buy router using factory (if available)
            if (factories[buyName]) {
              let pairAddr;
              try {
                pairAddr = await factories[buyName].getPair(TOKENS.USDC.address, token.address);
              } catch (err) {
                // some factories or calls may fail; treat as no pair
                pairAddr = ethers.ZeroAddress;
              }
              if (!pairAddr || pairAddr === ethers.ZeroAddress) {
                console.log(`[${tokenSymbol}] ⚠️ No pair on ${buyName}, skipping ${buyName}→${sellName}`);
                continue;
              }
            }

            // build paths and call getAmountsOut for buy
            const pathBuy = [TOKENS.USDC.address, token.address];
            let buyAmounts;
            try {
              buyAmounts = await buyRouter.getAmountsOut(TRADE_AMOUNT_USDC, pathBuy);
            } catch {
              // try WETH intermediary fallback
              const pathBuyWeth = [TOKENS.USDC.address, TOKENS.WETH.address, token.address];
              try {
                buyAmounts = await buyRouter.getAmountsOut(TRADE_AMOUNT_USDC, pathBuyWeth);
              } catch (err) {
                // no pool on buy side
                // console.log(`[${tokenSymbol}] ⚠️ No buy route ${buyName}→${tokenSymbol}`);
                continue;
              }
            }
            const tokenAmount = buyAmounts[buyAmounts.length - 1];

            // call getAmountsOut on sell router (sell tokenAmount -> USDC)
            const pathSell = [token.address, TOKENS.USDC.address];
            let sellAmounts;
            try {
              sellAmounts = await sellRouter.getAmountsOut(tokenAmount, pathSell);
            } catch {
              // try WETH intermediary fallback
              const pathSellWeth = [token.address, TOKENS.WETH.address, TOKENS.USDC.address];
              try {
                sellAmounts = await sellRouter.getAmountsOut(tokenAmount, pathSellWeth);
              } catch (err) {
                // no pool on sell side
                // console.log(`[${tokenSymbol}] ⚠️ No sell route ${sellName}→${tokenSymbol}`);
                continue;
              }
            }
            const usdcOut = sellAmounts[sellAmounts.length - 1];

            // profit in USDC base units (BigInt)
            const profit = BigInt(usdcOut.toString()) - BigInt(TRADE_AMOUNT_USDC.toString());

            // Logging in human-friendly USD
            const buyDollar = fmtUSDC(TRADE_AMOUNT_USDC);
            const sellDollar = fmtUSDC(usdcOut);
            const profitDollar = fmtUSDC(profit >= 0n ? profit : -profit); // show abs for formatting
            const sign = profit >= 0n ? "" : "-";

            console.log(
              `[${tokenSymbol} ${buyName}→${sellName}] 💱 Buy: $${buyDollar} → token: ${ethers.formatUnits(tokenAmount, token.decimals)}`
            );
            console.log(
              `[${tokenSymbol} ${buyName}→${sellName}] 💲 Sell: $${sellDollar} | Profit: ${sign}$${profitDollar}`
            );

            // If profit threshold exceeded -> execute
            if (profit >= BigInt(MIN_PROFIT_USDC.toString ? MIN_PROFIT_USDC : MIN_PROFIT_USDC)) {
              // NOTE: this executes on-chain and will spend gas. Keep this guarded.
              try {
                console.log(`[${tokenSymbol} ${buyName}→${sellName}] ✅ Profit >= threshold, attempting executeArbitrage...`);
                const tx = await arbContract.executeArbitrage(
                  routers[buyName].target ? routers[buyName].target : routers[buyName].address || routers[buyName],
                  routers[sellName].target ? routers[sellName].target : routers[sellName].address || routers[sellName],
                  token.address,
                  TRADE_AMOUNT_USDC,
                  { gasLimit: 1_500_000 }
                );
                console.log(`[${tokenSymbol}] ⛓️ TX submitted: ${tx.hash}`);
                await tx.wait();
                console.log(`[${tokenSymbol}] ✅ Arbitrage tx confirmed`);
              } catch (execErr) {
                console.warn(`[${tokenSymbol}] ⚠️ Execution failed: ${execErr?.message ?? execErr}`);
              }
            }

          } catch (err) {
            // Clean error messages for common conditions
            const code = err?.code ?? "";
            if (code === "BAD_DATA" || code === "CALL_EXCEPTION") {
              console.log(`[${tokenSymbol}] ⚠️ Error ${buyName}→${sellName}: ${err.message.split("\n")[0]}`);
            } else if (err?.message?.includes("Too Many Requests")) {
              console.log(`[${tokenSymbol}] ⚠️ RPC rate limit encountered; slowing scans`);
              await sleep(1000);
            } else {
              console.log(`[${tokenSymbol}] ❌ Unexpected error ${buyName}→${sellName}: ${err?.message ?? err}`);
            }
          }
        } // sell routers
      } // buy routers
    } // tokens

    // After scanning full list, wait a bit before next full run
    await sleep(3000);
  } // while
})().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
