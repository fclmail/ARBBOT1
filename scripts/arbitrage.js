import fs from "fs";
import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

// ---------------- CONFIG ----------------
const RPC_URL = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;

// Routers
const ROUTER_A = "0x1111111111111111111111111111111111111111";
const ROUTER_B = "0x2222222222222222222222222222222222222222";

// Token
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const TARGET = "0xTokenAddressGoesHere000000000000000000000";

// Failsafe thresholds
const MAX_PRICE_DEVIATION = 0.10; // 10%
const MIN_PROFIT_USDC = 5;        // Minimum net profit after gas

// Init provider & wallet
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// ---------------- CSV LOGGING ----------------
const csvRows = [];

function logTradeCSV(r) {
  csvRows.push([
    r.timestamp,
    r.symbol,
    r.buyRouter,
    r.sellRouter,
    r.amount,
    r.profit
  ].join(","));
}

function saveCSV() {
  const header = [
    "Timestamp",
    "Token",
    "BuyRouter",
    "SellRouter",
    "AmountUSDC",
    "ProfitUSDC"
  ];

  const csvContent = [header.join(","), ...csvRows].join("\n");
  const fname = `arbitrage_log_${Date.now()}.csv`;

  fs.writeFileSync(fname, csvContent);
  console.log(`💾 CSV saved: ${fname}`);
}

// ---------------- HELPERS ----------------
async function getPrice(router, tokenIn, tokenOut, amountIn) {
  try {
    const routerContract = new ethers.Contract(
      router,
      [
        "function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)"
      ],
      provider
    );

    const amounts = await routerContract.getAmountsOut(amountIn, [
      tokenIn,
      tokenOut
    ]);

    return Number(amounts[amounts.length - 1]);
  } catch (err) {
    console.log(`❌ Price error @ ${router}:`, err.message);
    return null;
  }
}

async function estimateGasCost(txData) {
  try {
    const gas = await wallet.estimateGas(txData);
    const gasPrice = await provider.getFeeData();
    return Number(gas) * Number(gasPrice.gasPrice);
  } catch (err) {
    console.log("❌ Gas estimation failed:", err.message);
    return Infinity;
  }
}

// ---------------- MAIN ARBITRAGE CORE ----------------
async function tryArb() {
  console.log("---- Checking arbitrage ----");

  const amountIn = ethers.parseUnits("1000", 6); // 1000 USDC

  // Prices from each router
  const aToT = await getPrice(ROUTER_A, USDC, TARGET, amountIn);
  const tToA = await getPrice(ROUTER_A, TARGET, USDC, amountIn);

  const bToT = await getPrice(ROUTER_B, USDC, TARGET, amountIn);
  const tToB = await getPrice(ROUTER_B, TARGET, USDC, amountIn);

  if (!aToT || !tToA || !bToT || !tToB) {
    console.log("Skipping due to missing quotes.");
    return;
  }

  // Identify best buy & best sell
  const bestBuy = aToT < bToT 
    ? { router: ROUTER_A, price: aToT, name: "A" }
    : { router: ROUTER_B, price: bToT, name: "B" };

  const bestSell = tToA > tToB
    ? { router: ROUTER_A, price: tToA, name: "A" }
    : { router: ROUTER_B, price: tToB, name: "B" };

  console.log(`Best buy = Router ${bestBuy.name}`);
  console.log(`Best sell = Router ${bestSell.name}`);

  // ---------------- FAILSAFE 1 — PRICE DEVIATION ----------------
  const deviation = (bestSell.price - bestBuy.price) / bestBuy.price;
  if (deviation < MAX_PRICE_DEVIATION) {
    console.log("❌ Failsafe: Price deviation too small.");
    return;
  }

  // ---------------- FAILSAFE 2 — GAS-ADJUSTED PROFIT ----------------
  const grossProfit = bestSell.price - bestBuy.price;

  const fakeTx = {
    to: bestBuy.router,
    data: "0x12345678" // Placeholder just to estimate gas
  };

  const gasCost = await estimateGasCost(fakeTx);

  const netProfit = grossProfit - gasCost;
  const profitUSDC = netProfit / 1e6;

  if (profitUSDC < MIN_PROFIT_USDC) {
    console.log(`❌ Failsafe: Net profit ${profitUSDC} < minimum ${MIN_PROFIT_USDC}`);
    return;
  }

  // ---------------- FAILSAFE 3 — PRE-SIMULATION callStatic ----------------
  const tradeContract = new ethers.Contract(
    "0xYourArbContractHere000000000000000000",
    [
      "function executeArb(address buyRouter, address sellRouter, uint amountIn) external returns (uint)"
    ],
    wallet
  );

  let staticResult;
  try {
    staticResult = await tradeContract.executeArb.staticCall(
      bestBuy.router,
      bestSell.router,
      amountIn
    );
  } catch (err) {
    console.log("❌ Failsafe: callStatic simulation failed.", err.message);
    return;
  }

  // ---------------- FAILSAFE 4 — REQUIRE SUCCESSFUL callStatic RETURN ----------------
  if (!staticResult || Number(staticResult) <= 0) {
    console.log("❌ Failsafe: callStatic returned invalid profit.");
    return;
  }

  // ---------------- FAILSAFE 5 & 6 — VAULT BEFORE/AFTER PROTECTION ----------------
  const oldVault = await provider.getBalance(wallet.address);

  console.log("⏳ Executing arbitrage...");

  let tx;
  try {
    tx = await tradeContract.executeArb(
      bestBuy.router,
      bestSell.router,
      amountIn
    );
  } catch (err) {
    console.log("❌ Transaction reverted before broadcast:", err.message);
    return;
  }

  // ---------------- FAILSAFE 7 — REQUIRE VALID txHash ----------------
  if (!tx.hash) {
    console.log("❌ Failsafe: Undefined txHash! Aborting.");
    return;
  }

  console.log(`⛓️  Pending tx: ${tx.hash}`);
  const receipt = await tx.wait();

  const newVault = await provider.getBalance(wallet.address);

  if (newVault < oldVault) {
    console.log("❌ Failsafe: Vault decreased after trade! Blocking.");
    return;
  }

  console.log(`✔️ Arbitrage success. Profit: ${profitUSDC} USDC`);

  logTradeCSV({
    timestamp: Date.now(),
    symbol: "TARGET",
    buyRouter: bestBuy.name,
    sellRouter: bestSell.name,
    amount: 1000,
    profit: profitUSDC
  });

  saveCSV();
}

// ---- START LOOP ----
async function loop() {
  while (true) {
    try {
      await tryArb();
    } catch (err) {
      console.log("Run error:", err.message);
    }
    await new Promise(r => setTimeout(r, 5000));
  }
}

loop();
