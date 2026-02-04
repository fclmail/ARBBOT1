import { ethers } from "ethers";

// ========== CONFIG ==========
const RPC_URL = "https://polygon-rpc.com"; // Example for Polygon
const provider = new ethers.JsonRpcProvider(RPC_URL);

const CONTRACT_ADDRESS = "0xYourVaultContractAddressHere";
const USDC_ADDRESS = "0xYourUSDCAddressHere";

// Routers you want to scan
const ROUTERS = {
  quickswap: "0xa5E0829CaCED8fFDD4De3c43696c57F7D7A678ff",
  sushiswap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  apeswap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607",
  dfyn: "0xA102072A4C07F06EC3B4900FDC4C7B80b6c57429",
};

// Tokens for simulation
const TOKENS = {
  WETH: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
  USDC: USDC_ADDRESS,
  AAVE: "0xD6DF932A45C0f255f85145f286eA0b292B21C90B",
};

// Path examples
const PATHS = {
  WETH_TO_USDC: [TOKENS.WETH, TOKENS.USDC],
  USDC_TO_WETH: [TOKENS.USDC, TOKENS.WETH],
};

// ABI fragments
const ROUTER_ABI = [
  "function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory amounts)"
];

const simulateArbitrage = async (amountIn, buyRouterAddr, sellRouterAddr, pathToToken, pathToUSDC) => {
  const buyRouter = new ethers.Contract(buyRouterAddr, ROUTER_ABI, provider);
  const sellRouter = new ethers.Contract(sellRouterAddr, ROUTER_ABI, provider);

  // Simulate first swap
  const amountsOut1 = await buyRouter.getAmountsOut(amountIn, pathToToken);
  const tokenAmount = amountsOut1[amountsOut1.length - 1];

  // Simulate second swap
  const amountsOut2 = await sellRouter.getAmountsOut(tokenAmount, pathToUSDC);
  const finalUSDC = amountsOut2[amountsOut2.length - 1];

  const profit = finalUSDC - amountIn;

  return {
    buyRouter: buyRouterAddr,
    sellRouter: sellRouterAddr,
    amountIn,
    tokenAmount,
    finalUSDC,
    profit
  };
};

const main = async () => {
  const amountInUSDC = ethers.parseUnits("1000", 6); // simulate $1000 USDC

  // Example: WETH arbitrage
  const results = [];

  const routers = Object.values(ROUTERS);

  // Scan all router pairs
  for (let i = 0; i < routers.length; i++) {
    for (let j = 0; j < routers.length; j++) {
      if (i === j) continue; // skip same router
      try {
        const result = await simulateArbitrage(
          amountInUSDC,
          routers[i],
          routers[j],
          PATHS.USDC_TO_WETH,
          PATHS.WETH_TO_USDC
        );
        results.push(result);
      } catch (err) {
        console.log(`Error simulating ${routers[i]} -> ${routers[j]}: ${err.reason || err}`);
      }
    }
  }

  console.log("=== Arbitrage Simulation Results ===");
  results.forEach(r => {
    console.log(`Buy: ${r.buyRouter} | Sell: ${r.sellRouter}`);
    console.log(`USDC In: ${ethers.formatUnits(r.amountIn, 6)} | USDC Out: ${ethers.formatUnits(r.finalUSDC, 6)} | Profit: ${ethers.formatUnits(r.profit, 6)}`);
    console.log("----------------------------");
  });
};

main();
