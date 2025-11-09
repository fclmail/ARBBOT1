#!/usr/bin/env node
/**
 * Robust arbitrage scanner (getAmountsOut-based)
 * - multi-base, multi-hop path generation
 * - factory pair checking when available
 * - RPC throttling & retry/backoff
 * - profit calculation in USDC base units
 * - executes arbContract when profit >= MIN_PROFIT_USDC
 *
 * No external color dependency.
 */

import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

// -------------------- CONFIG --------------------
const RPC_URL = process.env.RPC_URL || "https://polygon-bor-rpc.publicnode.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) {
  console.error("❌ Missing PRIVATE_KEY in environment");
  process.exit(1);
}

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// Hardcoded arbitrage contract (owner must be this wallet)
const ARB_CONTRACT = "0x19B64f74553eE0ee26BA01BF34321735E4701C43";

// Routers (keep them as known addresses). Use lowercase or checksummed addresses.
const ROUTERS = {
  Dfyn: "0xa8b607aa09b6a2641cf6f90f643e76d3f6e6ff73",
  ApeSwap: "0xc0788a3ad43d79aa53b09c2eacc313a787d1d607",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  QuickSwap: "0xa5e0829caced8ffdd4de3c43696c57f7d7a678ff",
  JetSwap: "0x6b3d817814eabc984d51896b1015c0b89e9737ca" // may be optional
};

// Factories (if known) to pre-check pair existence (some routers expose factory separately)
const FACTORIES = {
  Dfyn: "0x9ad32efcb1c6c92f9f9701d7a1f4c964f59e7fbd",    // example - adjust if needed
  ApeSwap: "0xcf083be4164828f00cae704ec15a36d711491284",
  SushiSwap: "0xc35dadb65012ec5796536bd9864ed8773abc74c4",
  QuickSwap: "0x5757371414417b8c6caad45baef941abc7d3ab32",
  JetSwap: undefined
};

// Token list (full list provided). Keep token decimals for formatting.
const TOKENS = {
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
  UNI2:{address:"0xb33eaad8d922b1083446dc23f610c2567fb5180f",decimals:18},
  USDC:{address:"0x2791bca1f2de4661ed88a30c99a7a9449aa84174",decimals:6},
  USDT:{address:"0xc2132d05d31c914a87c6611c10748aeb04b58e8f",decimals:6},
  WBTC:{address:"0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",decimals:8},
  WETH:{address:"0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",decimals:18},
  XSGD:{address:"0x70e8de73ce022f373d5a9f00b0ec0cf5835b0fc0",decimals:6},
};

// Bases to try (most common base tokens on Polygon)
const BASES = [
  TOKENS.USDC.address,
  TOKENS.USDT.address,
  TOKENS.WETH.address,
  "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270" // WMATIC
];

// Trade params
const TRADE_USD_STR = "100"; // $100 per arbitrage attempt (human string)
const TRADE_AMOUNT_USDC = ethers.parseUnits(TRADE_USD_STR, TOKENS.USDC.decimals); // BigInt
const MIN_PROFIT_USDC = ethers.parseUnits("0.01", TOKENS.USDC.decimals); // $0.01

// ABIs
const ROUTER_ABI = ["function getAmountsOut(uint256 amountIn, address[] memory path) view returns (uint256[] memory)"];
const FACTORY_ABI = ["function getPair(address tokenA, address tokenB) external view returns (address)"];
const ARB_ABI = ["function executeArbitrage(address buyRouter, address sellRouter, address token, uint256 amountIn) external"];

// Small color helpers (no deps)
const C = {
  cyan: (t)=>`\x1b[36m${t}\x1b[0m`,
  green:(t)=>`\x1b[32m${t}\x1b[0m`,
  yellow:(t)=>`\x1b[33m${t}\x1b[0m`,
  gray:(t)=>`\x1b[90m${t}\x1b[0m`,
  magenta:(t)=>`\x1b[35m${t}\x1b[0m`
};

// utility formatting
const now = ()=> new Date().toISOString();
const fmtUSDC = (big) => Number(ethers.formatUnits(big, TOKENS.USDC.decimals)).toFixed(6);

// provider readiness / retry wrapper (handles intermittent RPC failures)
async function waitForProvider(maxRetries = 5){
  let attempt = 0;
  while (attempt < maxRetries){
    try {
      await provider.getBlockNumber();
      return;
    } catch (err){
      attempt++;
      console.warn(`${C.yellow("WARN")} provider check failed (attempt ${attempt}) - ${err.message}. retrying in ${attempt}00ms`);
      await new Promise(r=>setTimeout(r, attempt * 100));
    }
  }
  throw new Error("Provider not responding after retries");
}

// Build router & factory contracts
const routerContracts = {};
const factoryContracts = {};
for (const [k,v] of Object.entries(ROUTERS)){
  routerContracts[k] = new ethers.Contract(v, ROUTER_ABI, provider);
  if (FACTORIES[k]) factoryContracts[k] = new ethers.Contract(FACTORIES[k], FACTORY_ABI, provider);
}

// arbitrage contract instance (wallet signer)
const arbContract = new ethers.Contract(ARB_CONTRACT, ARB_ABI, wallet);

// throttle controls
const MIN_DELAY_MS = 200; // delay between router calls to avoid rate-limit
const MAX_PATHS_PER_TOKEN = 12; // keep path explosion in check

// generate candidate buy/sell paths: single-hop and 2-hop using BASES
function generatePaths(tokenAddress){
  const paths = [];
  // single-hop from each base
  for (const b of BASES){
    paths.push([b, tokenAddress]);
  }
  // two-hop: base1 -> base2 -> token
  for (const b1 of BASES){
    for (const b2 of BASES){
      if (b1 === b2) continue;
      paths.push([b1, b2, tokenAddress]);
    }
  }
  // also try direct USDC -> token (already included), and limited size
  return paths.slice(0, MAX_PATHS_PER_TOKEN);
}

// check pair existence when factory contract provided (for base->token)
async function pairExists(factoryContract, a, b){
  if (!factoryContract) return true;
  try {
    const pair = await factoryContract.getPair(a, b);
    return pair && pair !== ethers.ZeroAddress;
  } catch {
    return true; // if factory call fails, allow fallback to getAmountsOut (will be caught)
  }
}

// main scanning of a single token across router pairs
async function scanToken(tokenSymbol, tokenObj){
  // generate buyPaths & sellPaths
  const buyPaths = generatePaths(tokenObj.address);
  const sellPaths = generatePaths(tokenObj.address).map(p => p.slice().reverse()); // reversed to sell

  for (const [buyName, buyAddr] of Object.entries(ROUTERS)){
    for (const [sellName, sellAddr] of Object.entries(ROUTERS)){
      if (buyName === sellName) continue;

      // small throttle before heavy RPC calls
      await new Promise(r => setTimeout(r, MIN_DELAY_MS));

      // pre-check pair existence for first hop when factory known (optional, avoids many calls)
      const buyFactory = factoryContracts[buyName];
      const sellFactory = factoryContracts[sellName];

      let buyTokenAmount = null; // BigNumber
      // try each buy path until one returns
      for (const path of buyPaths){
        try {
          // if factory available, check the first pair exists
          if (buyFactory){
            const ok = await pairExists(buyFactory, path[0], path[1]);
            if (!ok) { continue; }
          }
          const router = routerContracts[buyName];
          const out = await router.getAmountsOut(TRADE_AMOUNT_USDC, path);
          buyTokenAmount = out[out.length - 1];
          break;
        } catch (err){
          // ignore and try next path
          // console.debug(`[${tokenSymbol}] ${buyName} path failed: ${err.message}`);
        }
      }
      if (!buyTokenAmount) {
        // no buy route found
        console.log(`${C.gray(`[${tokenSymbol}]`)} ${buyName}→${sellName}: ${C.yellow("No buy route")}`);
        continue;
      }

      // try sell paths: convert token amount -> USDC
      let sellUSDCOut = null;
      for (const path of sellPaths){
        try {
          if (sellFactory){
            const ok = await pairExists(sellFactory, path[0], path[1]);
            if (!ok) { continue; }
          }
          const router = routerContracts[sellName];
          const out = await router.getAmountsOut(buyTokenAmount, path);
          sellUSDCOut = out[out.length - 1];
          break;
        } catch (err){
          // try next path
        }
      }
      if (!sellUSDCOut){
        console.log(`${C.gray(`[${tokenSymbol}]`)} ${buyName}→${sellName}: ${C.yellow("No sell route")}`);
        continue;
      }

      // compute profit in USDC base units (BigInt/BigNumber safe)
      const profitBN = BigInt(sellUSDCOut.toString()) - BigInt(TRADE_AMOUNT_USDC.toString());
      const profitHuman = Number(ethers.formatUnits(profitBN >= 0n ? profitBN : -profitBN, TOKENS.USDC.decimals)).toFixed(6);
      const buyUSD = fmtNumber(TRADE_AMOUNT_USDC, TOKENS.USDC.decimals);
      const sellUSD = fmtNumber(sellUSDCOut, TOKENS.USDC.decimals);

      const sign = profitBN >= 0n ? "" : "-";
      const profitSignText = (profitBN >= 0n) ? C.green(`+$${profitHuman}`) : C.gray(`-$${profitHuman}`);

      // Log nicely
      console.log(`${C.cyan(`[${tokenSymbol}]`)} ${buyName}→${sellName} | Buy: $${buyUSD} | Sell: $${sellUSD} | Profit: ${profitSignText}`);

      // Execute if profit meets threshold
      if (profitBN >= BigInt(MIN_PROFIT_USDC.toString())){
        console.log(C.yellow(`${now()} ⚡ Executing arbitrage for ${tokenSymbol} (${buyName}→${sellName}) — profit $${profitHuman}`));
        try {
          // Execute — note this will spend gas
          const tx = await arbContract.executeArbitrage(buyAddr, sellAddr, tokenObj.address, TRADE_AMOUNT_USDC, { gasLimit: 1_500_000 });
          console.log(C.magenta(`⛓️ TX submitted: ${tx.hash}`));
          await tx.wait();
          console.log(C.green(`✅ TX confirmed. Profit should be in contract ${ARB_CONTRACT}`));
        } catch (execErr){
          console.warn(C.gray(`${now()} ⚠ Execution failed: ${execErr?.message ?? execErr}`));
        }
      }

    } // sell routers
  } // buy routers
}

// small helper to format BigNumber or BigInt to decimal string
function fmtNumber(value, decimals = 6){
  try {
    return Number(ethers.formatUnits(value, decimals)).toFixed(6);
  } catch {
    // fallback when value is BigInt
    return (Number(value) / Math.pow(10, decimals)).toFixed(6);
  }
}

// -------------------- MAIN LOOP --------------------
(async function main(){
  console.log(`🔗 Contract: ${ARB_CONTRACT}`);
  console.log(`💰 Trade Amount: $${TRADE_USD_STR}`);
  console.log(`📈 Min Profit: $${Number(ethers.formatUnits(MIN_PROFIT_USDC, TOKENS.USDC.decimals)).toFixed(6)}`);
  console.log(`🔧 Using Routers: ${Object.keys(ROUTERS).join(", ")}`);
  console.log(`🔧 Bases tried: ${BASES.join(", ")}`);
  console.log();

  await waitForProvider(10);

  // continuous scan
  while (true){
    console.log(`\n${now()} ▸ Scanning tokens...`);
    for (const [symbol, token] of Object.entries(TOKENS)){
      if (symbol === "USDC") continue;
      try {
        await scanToken(symbol, token);
      } catch (err){
        console.error(`${C.gray(`[${symbol}]`)} ERROR scanning token: ${err?.message ?? err}`);
        // small pause on unexpected errors to avoid flood
        await new Promise(r=>setTimeout(r, 500));
      }
    }
    console.log(C.magenta(`Cycle complete — sleeping 3s before next run`));
    await new Promise(r => setTimeout(r, 3000));
  }

})().catch(err=>{
  console.error("Fatal:", err);
  process.exit(1);
});
