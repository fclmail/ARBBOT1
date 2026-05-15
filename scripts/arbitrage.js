import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config();

const RPCS = [
  "https://polygon-rpc.com",
  "https://1rpc.io/matic",
  "https://polygon-bor.publicnode.com"
];

let provider;

for (const rpc of RPCS) {
  try {
    provider = new ethers.JsonRpcProvider(rpc);
    console.log(`🟢 CONNECTED RPC → ${rpc}`);
    break;
  } catch (e) {
    console.log(`❌ RPC FAILED → ${rpc}`);
  }
}

const QUICKSWAP = "0xa5E0829CaCED8fFDD4De3c43696c57F7D7A678ff";
const SUSHISWAP = "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506";

const TOKENS = {
  USDC: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  WETH: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
  DAI: "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063",
  WBTC: "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6",
  CRV: "0x172370d5Cd63279eFa6d502DAB29171933a610AF",
  AAVE: "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9",
  LINK: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39",
  USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
  UNI: "0xb33EaAd8d922B1083446DC23f610c2567fB5180f",
  BAL: "0x9a71012b13ca4d3d0cdc72a177df3ef03b0e76a3"
};

const ROUTER_ABI = [
  "function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory amounts)"
];

const quickRouter = new ethers.Contract(QUICKSWAP, ROUTER_ABI, provider);
const sushiRouter = new ethers.Contract(SUSHISWAP, ROUTER_ABI, provider);

const ROUTERS = {
  QUICKSWAP: quickRouter,
  SUSHISWAP: sushiRouter
};

// FIXED: Proper route generation with return to USDC
function generateHopRoutes(maxHops = 2) {
  const tokens = Object.keys(TOKENS).filter(t => t !== "USDC");
  const routes = [];

  function build(route, depth) {
    if (depth === maxHops) {
      // Always end with USDC for arbitrage
      routes.push([...route, "USDC"]);
      return;
    }

    for (const t of tokens) {
      if (!route.includes(t)) { // No repeat tokens
        build([...route, t], depth + 1);
      }
    }
  }

  build([], 0);
  
  // If no routes generated, create simple 2-token paths
  if (routes.length === 0) {
    for (const t of tokens) {
      routes.push([t, "USDC"]);
    }
  }
  
  return routes;
}

async function simulateRoute(router, route) {
  const amountIn = ethers.parseUnits("1", 6); // 1 USDC
  let amount = amountIn;

  for (let i = 0; i < route.length - 1; i++) {
    const from = TOKENS[route[i]];
    const to = TOKENS[route[i + 1]];
    const path = [from, to];

    try {
      const amounts = await router.getAmountsOut(amount, path);
      if (amounts[amounts.length - 1] === 0n) return 0;
      amount = amounts[amounts.length - 1];
    } catch {
      return 0;
    }
  }

  return parseFloat(ethers.formatUnits(amount, 6));
}

async function scanRoutes() {
  const routes = generateHopRoutes(2);
  let best = { profit: -Infinity, route: null, router: null };
  const MIN_PROFIT = 0.001;
  const GAS_COST = 0.005;

  console.log(`\n🟢 GENERATING ${routes.length} ROUTES`);

  for (const [routerName, router] of Object.entries(ROUTERS)) {
    console.log(`\n🟢 TESTING ROUTER → ${routerName}`);

    for (const route of routes) {
      const out = await simulateRoute(router, route);
      const profit = out - 1; // Subtract 1 USDC input
      const netProfit = profit - GAS_COST;

      if (out > 0) {
        console.log(
          `📊 ${route.join(" → ")} = ${out.toFixed(6)} USDC | ` +
          `Profit: ${(profit * 100).toFixed(4)}% | Net: ${netProfit.toFixed(6)}`
        );
      }

      if (netProfit > best.profit && netProfit >= MIN_PROFIT) {
        best = { profit: netProfit, route, router: routerName };
      }
    }
  }

  if (best.route && best.profit > 0) {
    console.log("\n🏆 BEST ROUTE →", best.route.join(" → "));
    console.log(`📊 PROFIT → ${best.profit.toFixed(6)} USDC`);
  } else {
    console.log("\n❌ NO PROFITABLE ROUTE FOUND");
  }

  return best;
}

async function execute(best) {
  if (!best?.route || best.profit <= 0) return;

  console.log("\n🚀 EXECUTING ARBITRAGE");
  console.log(`📡 Route: ${best.route.join(" → ")}`);
  console.log(`💰 Profit: ${best.profit.toFixed(6)} USDC`);
  
  // In production, this would call your smart contract
  console.log("🟢 TRANSACTION SIMULATED (no real execution)");
}

async function main() {
  console.log("🚀 ARBITRAGE BOT STARTED\n");

  while (true) {
    try {
      console.log("\n" + "=".repeat(50));
      console.log(`🕐 ${new Date().toLocaleTimeString()}`);
      console.log("=".repeat(50));

      const best = await scanRoutes();

      if (best?.profit > 0) {
        await execute(best);
      }

      await new Promise(r => setTimeout(r, 5000));
    } catch (e) {
      console.log("❌ ERROR:", e.message);
    }
  }
}

// Verify setup before starting
provider.getBlockNumber()
  .then(block => {
    console.log(`🟢 POLYGON BLOCK: ${block}`);
    main();
  })
  .catch(e => {
    console.log("❌ CANNOT CONNECT TO POLYGON:", e.message);
    process.exit(1);
  });
