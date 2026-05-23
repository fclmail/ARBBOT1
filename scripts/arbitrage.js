import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config();

/* ================= RPC ================= */

const RPCS = [
  "https://polygon-bor.publicnode.com",
  "https://polygon-rpc.com"
];

let provider;

for (const rpc of RPCS) {
  try {
    provider = new ethers.JsonRpcProvider(rpc);
    console.log("🟢 CONNECTED RPC →", rpc);
    break;
  } catch (e) {}
}

if (!provider) {
  throw new Error("No RPC available");
}

/* ================= WALLET ================= */

const PRIVATE_KEY = process.env.PRIVATE_KEY;

if (!PRIVATE_KEY) {
  throw new Error("Missing PRIVATE_KEY");
}

const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

console.log("\n🟢 WALLET CONNECTED →");
console.log(wallet.address);

/* ================= CONTRACT ================= */

const ARB_CONTRACT =
  "0xB1a557c33FF23F3C0Ffa2A9251630197b037F4cc";

console.log("\n🟢 ARB CONTRACT →");
console.log(ARB_CONTRACT);

/* ================= SAFE ADDRESS ================= */

const safeAddress = (addr) =>
  ethers.getAddress(addr.toLowerCase());

/* ================= ABI ================= */

const ABI = [
  "function executeAaveFlashLoanArbitrage(address,address,uint256,address[],address[],uint256) external",
  "function simulateArbitrageProfit(address,address,uint256,address[],address[]) view returns (uint256,uint256)",
  "function minimumProfitUSDC() view returns (uint256)"
];

const contract =
  new ethers.Contract(
    ARB_CONTRACT,
    ABI,
    wallet
  );

/* ================= TOKENS (FIX 4 ADDED MORE TOKENS) ================= */

const TOKENS = {
  USDC: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  WETH: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
  USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
  DAI: "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063",

  // FIX 4 — expanded JS1-style token universe
  AAVE: "0xd6df932a45c0f255f85145f286ea0b292b21c90b",
  APE: "0x4d224452801aced8b2f0aebe155379bb5d594381",
  CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
  LINK: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39",
  QUICK: "0x831753dd7087cac61ab5644b308642cc1c33dc13",
  SHIB: "0x6f8a06447ff6fcf75a5fcdb3f8c4bab2da4fc0d0",
  UNI: "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984",
  WBTC: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6"
};

/* ================= ROUTERS ================= */

const QUICKSWAP = safeAddress("0xa5E0829CaCED8fFDD4De3c43696c57F7D7A678ff");
const SUSHISWAP = safeAddress("0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506");
const APESWAP = safeAddress("0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607");
const DFYN = safeAddress("0xA102072A4C07F06EC3B4900FDC4C7B80b6c57429");

/* ================= DEX PAIRS ================= */

const DEXES = [
  QUICKSWAP,
  SUSHISWAP,
  APESWAP,
  DFYN
];

/* ================= FIX 2 — TINY FLASHLOAN SIZES ================= */

const CANDIDATE_SIZES = [
  ethers.parseUnits("0.01", 6),
  ethers.parseUnits("0.02", 6),
  ethers.parseUnits("0.05", 6),
  ethers.parseUnits("0.1", 6),
  ethers.parseUnits("0.25", 6),
  ethers.parseUnits("0.5", 6),
  ethers.parseUnits("1", 6)
];

/* ================= FIX 1 — DYNAMIC PATH BUILDERS ================= */

function buildBuyPaths(token) {
  return [
    [TOKENS.USDC, token],
    [TOKENS.USDC, TOKENS.WETH, token],
    [TOKENS.USDC, TOKENS.WMATIC, token],
    [TOKENS.USDC, TOKENS.DAI, token],
    [TOKENS.USDC, TOKENS.USDT, token]
  ];
}

function buildSellPaths(token) {
  return [
    [token, TOKENS.USDC],
    [token, TOKENS.WETH, TOKENS.USDC],
    [token, TOKENS.WMATIC, TOKENS.USDC],
    [token, TOKENS.DAI, TOKENS.USDC],
    [token, TOKENS.USDT, TOKENS.USDC]
  ];
}

/* ================= FIX 3 — FULL COMBINATION SCANNER ================= */

async function getBestRoute() {

  console.log("\n🔍 SCANNING ALL PATHS (JS1-STYLE EXPANDED)");

  let best = null;
  let bestProfit = 0n;

  const minProfit = await contract.minimumProfitUSDC();

  console.log(
    "\nMIN PROFIT REQUIRED:",
    ethers.formatUnits(minProfit, 6),
    "USDC"
  );

  const tokens = Object.values(TOKENS);

  for (const dexA of DEXES) {
    for (const dexB of DEXES) {

      if (dexA === dexB) continue;

      for (const token of tokens) {

        const buyPaths = buildBuyPaths(token);
        const sellPaths = buildSellPaths(token);

        for (const buyPath of buyPaths) {
          for (const sellPath of sellPaths) {

            for (const size of CANDIDATE_SIZES) {

              try {

                const result =
                  await contract.simulateArbitrageProfit(
                    dexA,
                    dexB,
                    size,
                    buyPath,
                    sellPath
                  );

                const finalUSDC = result[0];
                const profit = result[1];

                if (profit > bestProfit) {

                  bestProfit = profit;

                  best = {
                    routerA: dexA,
                    routerB: dexB,
                    amount: size,
                    pathToToken: buyPath,
                    pathToUSDC: sellPath,
                    estimatedFinalUSDC: finalUSDC,
                    estimatedProfit: profit,
                    token
                  };

                  console.log("\n🔥 NEW BEST FOUND");
                  console.log("PROFIT:", ethers.formatUnits(profit, 6));
                }

              } catch {}
            }
          }
        }
      }
    }
  }

  return best;
}

/* ================= EXECUTION ================= */

async function executeTrade(best) {

  if (!best || best.estimatedProfit <= 0n) {
    console.log("\n❌ NO PROFITABLE ROUTE");
    return;
  }

  console.log("\n🏆 EXECUTING BEST ROUTE");
  console.log("PROFIT:", ethers.formatUnits(best.estimatedProfit, 6));

  const deadline = Math.floor(Date.now() / 1000) + 60;

  try {

    const tx =
      await contract.executeAaveFlashLoanArbitrage(
        best.routerA,
        best.routerB,
        best.amount,
        best.pathToToken,
        best.pathToUSDC,
        deadline
      );

    console.log("TX SENT:", tx.hash);

    await tx.wait();

    console.log("✅ EXECUTION COMPLETE");

  } catch (e) {

    console.log("❌ EXECUTION FAILED");
    console.log(e.reason || e.message);
  }
}

/* ================= MAIN LOOP ================= */

async function main() {

  console.log("\n🚀 JS2 FIXED BOT STARTED");

  const block = await provider.getBlockNumber();

  console.log("BLOCK:", block);

  while (true) {

    console.log("\n" + "=".repeat(70));

    const best = await getBestRoute();

    await executeTrade(best);

    await new Promise(r => setTimeout(r, 5000));
  }
}

main();
