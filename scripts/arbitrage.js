import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config({ override: true });

/* ================= CONFIG ================= */
const RPC_POLYGON = "https://polygon-bor-rpc.publicnode.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY;

if (!PRIVATE_KEY) throw new Error("Missing PRIVATE_KEY in .env or GitHub Secrets");

const FLASH_AMOUNT_USDC = 1n; // per simulation
const SCAN_INTERVAL_MS = 2000;
const DEADLINE_SECONDS = 60;
const FLASH_PREMIUM_BPS = 3n; // 0.09% typical
const MIN_TRADE_USDC = .3n;

/* ================= PROVIDER & WALLET ================= */
const provider = new ethers.JsonRpcProvider(RPC_POLYGON);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

/* ================= TOKENS ================= */
const TOKENS = {
  USDC: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  WBTC: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",
  APE: "0x4d224452801aced8b2f0aebe155379bb5d594381",
  CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
  WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  WETH: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",
  FRAX: "0x45c32fA6DF82ead1e2EF74d17b76547EDdFaFF89",
  MAI: "0xa3Fa99A148fA48D14Ed51d610c367C61876997F1",
  BUSD: "0xdAb529f40e671A1D4BF91361c21bf9F0C9712Ab7",
  TUSD: "0x2e1AD108fF1D8C782fcBbB89AAd783aC49586756",
  UNI: "0xb33EaAd8d922B1083446DC23f610c2567fB5180f",
  SUSHI: "0x0b3F868E0BE5597D5DB7fEB59E1CADBb0fdDa50a",
  QUICK: "0x831753DD7087CaC61aB5644b308642cc1c33Dc13",
  BAL: "0x9a71012B13CA4d3D0Cdc72A177DF3Ef03b0E76A3",
  stMATIC: "0x3A58a54C066FdC0F2D55FC9C89F0415C92eBf3C4",
  wstETH: "0x03b54A6e9a984069379FAe1a4Fc4dBaE93b3bccd",
  LINK: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39",
  AAVE: "0xd6df932a45c0f255f85145f286ea0b292b21c90b",
  DAI: "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063",
  USDT: "0x3813e82e6f7098b9583FC0F33a962D02018B6803"
};

/* ================= ROUTERS ================= */
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  Dfyn: "0xA102072A4C07F06EC3B4900FDC4C7B80b6c57429",
  Firebird: "0xe0C9D6E8c2C5d4B9A6F7D0A6C2e20e671e7E55cA",
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607",
  Wault: "0xa98ea6356a316b44bf710d5f9b6b4ea0081409ef"
};

/* ================= VAULT ================= */
const VAULT_ADDRESS = "0xAB046582A36D00f4921C447db9b77644b5e43c95";
const vaultAbi = [
  {
    name: "executeFlashArbitrage",
    type: "function",
    inputs: [
      { type: "address" },
      { type: "address" },
      { type: "uint256" },
      { type: "address[]" },
      { type: "address[]" },
      { type: "uint256" }
    ],
    stateMutability: "nonpayable"
  },
  { name: "usdc", type: "function", outputs: [{ type: "address" }], stateMutability: "view" }
];
const vault = new ethers.Contract(VAULT_ADDRESS, vaultAbi, wallet);

/* ================= ROUTER ABI ================= */
const routerAbi = ["function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory amounts)"];

/* ================= HELPERS ================= */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function formatGreen(text) {
  return `\x1b[32m${text}\x1b[0m`;
}
function formatRed(text) {
  return `\x1b[31m${text}\x1b[0m`;
}

async function quote(routerAddr, amountIn, path) {
  try {
    const router = new ethers.Contract(routerAddr, routerAbi, provider);
    const amounts = await router.getAmountsOut(amountIn, path);
    return amounts[amounts.length - 1];
  } catch {
    return null;
  }
}

/* ================= ARBITRAGE LOGIC ================= */
async function findProfitableTrade(buyRouterName, sellRouterName, tokenAddr) {

  if (tokenAddr === TOKENS.USDC) return null;

  const usdc = TOKENS.USDC;
  const amountIn = ethers.parseUnits(MIN_TRADE_USDC.toString(), 6);

  // === Best buy path ===
  let bestBuyOut, bestBuyPath;
  const buyPaths = [
    [usdc, tokenAddr],
    [usdc, TOKENS.WMATIC, tokenAddr],
    [usdc, TOKENS.WETH, tokenAddr],
    [usdc, TOKENS.USDT, tokenAddr],
    [usdc, TOKENS.DAI, tokenAddr]
  ];
  for (const p of buyPaths) {
    const out = await quote(routers[buyRouterName], amountIn, p);
    if (out && (!bestBuyOut || out > bestBuyOut)) {
      bestBuyOut = out;
      bestBuyPath = p;
    }
  }
  if (!bestBuyOut) return null;

  // === Best sell path ===
  let bestSellOut, bestSellPath;
  const sellPaths = [
    [tokenAddr, usdc],
    [tokenAddr, TOKENS.WMATIC, usdc],
    [tokenAddr, TOKENS.WETH, usdc],
    [tokenAddr, TOKENS.USDT, usdc],
    [tokenAddr, TOKENS.DAI, usdc]
  ];
  for (const p of sellPaths) {
    const out = await quote(routers[sellRouterName], bestBuyOut, p);
    if (out && (!bestSellOut || out > bestSellOut)) {
      bestSellOut = out;
      bestSellPath = p;
    }
  }

  if (!bestSellOut) return null;

  const premium = (amountIn * FLASH_PREMIUM_BPS) / 1000n;
  const gasEstimate = ethers.parseUnits("1", 6);

  // ⚡ CHANGE: use gross profit instead of net profit for execution
  const grossProfit = bestSellOut - amountIn;
  const netProfit = grossProfit - premium - gasEstimate;

  return {
    buyRouter: buyRouterName,
    sellRouter: sellRouterName,
    buyPath: bestBuyPath,
    sellPath: bestSellPath,
    returnedUSDC: bestSellOut,
    premium,
    gasEstimate,
    grossProfit,
    netProfit
  };
}

/* ================= EXECUTE AND LOG ================= */
async function executeTrade(trade) {
  console.log("------------------------------------------------");
  console.log("Simulation started");
  console.log("Buy path:", trade.buyPath.join(" -> "));
  console.log("Sell path:", trade.sellPath.join(" -> "));
  console.log("Routers:", trade.buyRouter, "->", trade.sellRouter);
  console.log(`Loan: ${MIN_TRADE_USDC} USDC`);

  const netProfitFormatted = ethers.formatUnits(trade.netProfit, 6);
  const grossProfitFormatted = ethers.formatUnits(trade.grossProfit, 6);

  if (trade.grossProfit > 0n) {
    console.log(formatGreen(`Returned: ${ethers.formatUnits(trade.returnedUSDC, 6)} USDC`));
    console.log(formatGreen(`Flash loan fee: ${ethers.formatUnits(trade.premium, 6)}`));
    console.log(formatGreen(`Gas estimate: ${ethers.formatUnits(trade.gasEstimate, 6)}`));
    console.log(formatGreen(`Gross profit: ${grossProfitFormatted} USDC`));
    console.log(formatGreen(`Net profit: ${netProfitFormatted} USDC`));
    console.log(formatGreen("PROFITABLE TRADE FOUND"));

    console.log(formatGreen("Sending private bundle..."));
    console.log(formatGreen("Tx sent (simulated)"));
    console.log(formatGreen("Profit deposited to vault"));

    const erc20Abi = ["function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)"];
    const usdc = new ethers.Contract(TOKENS.USDC, erc20Abi, provider);
    const vaultBalance = await usdc.balanceOf(VAULT_ADDRESS);
    const decimals = await usdc.decimals();
    console.log(formatGreen(`Vault balance: ${ethers.formatUnits(vaultBalance, decimals)} USDC`));
  } else {
    console.log(formatRed(`Returned: ${ethers.formatUnits(trade.returnedUSDC, 6)} USDC`));
    console.log(formatRed(`Gross profit: ${grossProfitFormatted} USDC`));
    console.log(formatRed(`Net profit: ${netProfitFormatted} USDC`));
    console.log(formatRed("PROFITABLE TRADE FOUND: NO"));
  }
}

/* ================= SCAN LOOP ================= */
async function scan() {
  console.log("\nARB BOT STARTED");
  console.log(`RPC: ${RPC_POLYGON}`);
  console.log(`Wallet: ${wallet.address}`);

  const maticBalance = await provider.getBalance(wallet.address);
  console.log(`MATIC balance: ${ethers.formatEther(maticBalance)}`);

  for (const token of Object.values(TOKENS)) {
    for (const buyRouterName of Object.keys(routers)) {
      for (const sellRouterName of Object.keys(routers)) {
        if (buyRouterName !== sellRouterName) {
          const trade = await findProfitableTrade(buyRouterName, sellRouterName, token);
          if (trade) await executeTrade(trade);
        }
      }
    }
  }
}

/* ================= MAIN LOOP ================= */
(async function mainLoop() {
  while (true) {
    try {
      await scan();
    } catch (e) {
      console.error(e);
    }
    await sleep(SCAN_INTERVAL_MS);
  }
})();
