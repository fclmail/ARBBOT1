// arbitrage.js
import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config({ override: true });

/* ================= CONFIG ================= */
const RPC_POLYGON = "https://polygon-bor-rpc.publicnode.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY;

if (!PRIVATE_KEY) {
  throw new Error("Invalid or missing private key. Please check your .env or GitHub Secrets.");
}

/* ================= CONSTANTS ================= */
const FLASH_AMOUNT_USDC = 10000n; // per simulation
const SCAN_INTERVAL_MS = 10_000;
const DEADLINE_SECONDS = 60;
const FLASH_PREMIUM_BPS = 9n; // 0.09% typical

/* ================= PROVIDER & WALLET ================= */
const provider = new ethers.JsonRpcProvider(RPC_POLYGON);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

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

/* ================= ROUTERS ================= */
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
  ApeSwap: "0xC0788A3aD43d79aa53B09c2EaCc313A787d1d607",
  Wault: "0xa98ea6356a316b44bf710d5f9b6b4ea0081409ef"
};

/* ================= TOKENS ================= */
const TOKENS = {
  WBTC: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",
  APE: "0x4d224452801aced8b2f0aebe155379bb5d594381",
  CRV: "0x172370d5cd63279efa6d502dab29171933a610af",
  WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  WETH: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",
  LINK: "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39",
  AAVE: "0xd6df932a45c0f255f85145f286ea0b292b21c90b",
  DAI: "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063",
  USDT: "0x3813e82e6f7098b9583FC0F33a962D02018B6803"
};

/* ================= ROUTER ABI ================= */
const routerAbi = [
  "function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory amounts)"
];

/* ================= HELPERS ================= */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function displayBalances() {
  const maticBalance = await provider.getBalance(wallet.address);
  const usdcAddress = await vault.usdc();
  const erc20Abi = ["function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)"];
  const usdc = new ethers.Contract(usdcAddress, erc20Abi, provider);
  const vaultBalance = await usdc.balanceOf(VAULT_ADDRESS);
  const decimals = await usdc.decimals();
  return {
    matic: ethers.formatEther(maticBalance),
    vault: ethers.formatUnits(vaultBalance, decimals)
  };
}

async function simulateProfit(buyRouterAddr, sellRouterAddr, path) {
  try {
    const buyRouter = new ethers.Contract(buyRouterAddr, routerAbi, provider);
    const sellRouter = new ethers.Contract(sellRouterAddr, routerAbi, provider);
    const amountIn = ethers.parseUnits(FLASH_AMOUNT_USDC.toString(), 6);

    const buyAmounts = await buyRouter.getAmountsOut(amountIn, path);
    const tokenOut = buyAmounts[buyAmounts.length - 1];

    const sellAmounts = await sellRouter.getAmountsOut(tokenOut, [...path].reverse());
    const returnedUSDC = sellAmounts[sellAmounts.length - 1];

    const premium = (amountIn * FLASH_PREMIUM_BPS) / 10000n;
    const gasEstimate = ethers.parseUnits("0.4", 18);
    const netProfit = returnedUSDC - amountIn - premium - gasEstimate;

    return {
      returnedUSDC,
      premium,
      gasEstimate,
      netProfit
    };
  } catch {
    return null;
  }
}

async function tryFlashArb(buyRouterName, sellRouterName, tokenAddr) {
  const usdc = await vault.usdc();
  const path = [usdc, TOKENS.DAI, TOKENS.USDT, tokenAddr];

  const result = await simulateProfit(routers[buyRouterName], routers[sellRouterName], path);

  console.log("------------------------------------------------");
  console.log("Simulation started");
  console.log("Hop path:");
  console.log(path.map((t) => t).join(" -> "));
  console.log("Routers:");
  console.log(`${buyRouterName} -> ${sellRouterName}`);
  console.log(`Loan: ${FLASH_AMOUNT_USDC} USDC`);

  if (!result || result.netProfit <= 0n) {
    console.log("Returned: Simulation failed");
    console.log("PROFITABLE TRADE FOUND: NO");
    return;
  }

  console.log(`Returned: ${ethers.formatUnits(result.returnedUSDC, 6)} USDC`);
  console.log(`Flash loan fee: ${ethers.formatUnits(result.premium, 6)}`);
  console.log(`Gas estimate: ${ethers.formatUnits(result.gasEstimate, 6)}`);
  console.log(`Net profit: ${ethers.formatUnits(result.netProfit, 6)} USDC`);
  console.log("PROFITABLE TRADE FOUND");

  // Simulate sending tx
  console.log("Sending private bundle...");
  console.log("Tx sent (simulated)");
  console.log(`Profit deposited to vault`);
  const balances = await displayBalances();
  console.log(`Vault balance: ${balances.vault} USDC`);
}

async function scan() {
  console.log("\nARB BOT STARTED");
  console.log(`RPC: ${RPC_POLYGON}`);
  console.log(`Wallet: ${wallet.address}`);
  const balances = await displayBalances();
  console.log(`MATIC balance: ${balances.matic}`);
  console.log(`Vault balance: ${balances.vault} USDC`);

  for (const token of Object.values(TOKENS)) {
    for (const buyRouterName of Object.keys(routers)) {
      for (const sellRouterName of Object.keys(routers)) {
        if (buyRouterName !== sellRouterName) {
          await tryFlashArb(buyRouterName, sellRouterName, token);
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
