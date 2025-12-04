import { ethers } from "ethers";

// ---------------- CONFIG ----------------
const RPC_URL = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;

const VAULT_ADDRESS = "0x7DadE334120e659eDE4999c8813c183648b1bd19";
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

const DRY_RUN = false;          // true = simulate only
const TRADE_USDC = 0.05;        // Amount per trade in USDC
const MIN_PROFIT_PCT = 0.2;     // Minimum profit % to execute

const USDC_DECIMALS = 6;

// ---------------- PROVIDER & WALLET ----------------
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// ---------------- VAULT CONTRACT ----------------
const vaultABI = [ /* full ABI here */ ];
const vaultContract = new ethers.Contract(VAULT_ADDRESS, vaultABI, wallet);

// ---------------- ROUTER ABI ----------------
const routerABI = [
  "function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory)"
];

// ---------------- UTILS ----------------
function toUSDC(value) {
  return ethers.parseUnits(value.toString(), USDC_DECIMALS);
}

function fromUSDC(value) {
  return Number(ethers.formatUnits(value, USDC_DECIMALS));
}

async function getVaultUSDCBalance() {
  const usdc = new ethers.Contract(USDC_ADDRESS, [
    "function balanceOf(address) view returns (uint256)"
  ], provider);
  return await usdc.balanceOf(VAULT_ADDRESS);
}

// ---------------- PROFIT CALC ----------------
async function getExpectedProfit(buyRouterAddr, sellRouterAddr, tokenAddr, tradeAmountUSDC) {
  const buyRouter = new ethers.Contract(buyRouterAddr, routerABI, provider);
  const sellRouter = new ethers.Contract(sellRouterAddr, routerABI, provider);

  const amountIn = toUSDC(tradeAmountUSDC);

  // Swap path USDC -> TOKEN -> USDC
  const buyPath = [USDC_ADDRESS, tokenAddr];
  const sellPath = [tokenAddr, USDC_ADDRESS];

  try {
    const amountsBought = await buyRouter.getAmountsOut(amountIn, buyPath);
    const tokenAmount = amountsBought[amountsBought.length - 1];

    const amountsSold = await sellRouter.getAmountsOut(tokenAmount, sellPath);
    const usdcReceived = amountsSold[amountsSold.length - 1];

    const profit = fromUSDC(usdcReceived - amountIn);
    const profitPct = (profit / tradeAmountUSDC) * 100;

    return { profit, profitPct, amountInUSDC_BN: amountIn, minReturnUSDC_BN: usdcReceived };
  } catch (e) {
    console.error("Profit calc error:", e.message);
    return { profit: -9999, profitPct: -9999, amountInUSDC_BN: amountIn, minReturnUSDC_BN: amountIn };
  }
}

// ---------------- ARB EXECUTION ----------------
async function simulateAndExecute(buyRouter, sellRouter, tokenObj, amountInUSDC_BN, minReturnUSDC_BN) {
  try {
    // Simulate
    await vaultContract.callStatic.executeArbitrage(
      buyRouter,
      sellRouter,
      tokenObj.address,
      amountInUSDC_BN,
      minReturnUSDC_BN
    );
  } catch (e) {
    throw new Error(`Simulation failed: ${e?.message ?? e}`);
  }

  if (DRY_RUN) return { txHash: null, profitReal: 0 };

  const before = await getVaultUSDCBalance();

  let txOpts = { gasLimit: 1_200_000n };
  try {
    const feeData = await provider.getFeeData();
    if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
      txOpts.maxFeePerGas = feeData.maxFeePerGas;
      txOpts.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas;
    } else if (feeData.gasPrice) {
      txOpts.gasPrice = feeData.gasPrice;
    }
  } catch {}

  const tx = await vaultContract.executeArbitrage(
    buyRouter,
    sellRouter,
    tokenObj.address,
    amountInUSDC_BN,
    minReturnUSDC_BN,
    txOpts
  );
  console.log(`TX sent: ${tx.hash}`);
  const receipt = await tx.wait();

  const after = await getVaultUSDCBalance();
  const profitReal = fromUSDC(after - before);

  // Decode event
  let decodedEvent = null;
  try {
    for (const l of receipt.logs) {
      try {
        const parsed = vaultContract.interface.parseLog(l);
        if (parsed.name === "ArbitrageExecuted") {
          decodedEvent = {
            executor: parsed.args.executor,
            buyRouter: parsed.args.buyRouter,
            sellRouter: parsed.args.sellRouter,
            token: parsed.args.token,
            amountIn: parsed.args.amountIn.toString(),
            beforeUSDC: fromUSDC(parsed.args.beforeUSDC),
            afterUSDC: fromUSDC(parsed.args.afterUSDC),
            profitUSDC: fromUSDC(parsed.args.profitUSDC)
          };
          break;
        }
      } catch {}
    }
  } catch {}

  return { txHash: tx.hash, receipt, profitReal, decodedEvent };
}

// ---------------- MAIN LOOP ----------------
async function scanAndTrade() {
  console.log(`Starting arb scanner. DRY_RUN=${DRY_RUN}, TRADE_USDC=${TRADE_USDC}, MIN_PROFIT_PCT=${MIN_PROFIT_PCT}%`);

  const tokenList = [
    { symbol: "WETH", address: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619" },
    { symbol: "WBTC", address: "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6" },
    { symbol: "CRV",  address: "0x172370d5Cd63279eFa6d502DAB29171933a610AF" }
  ];

  const routers = {
    quickswap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
    sushiswap: "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506"
  };

  for (const token of tokenList) {
    for (const [buyName, buyRouter] of Object.entries(routers)) {
      const sellName = buyName === "quickswap" ? "sushiswap" : "quickswap";
      const sellRouter = routers[sellName];

      const { profit, profitPct, amountInUSDC_BN, minReturnUSDC_BN } =
        await getExpectedProfit(buyRouter, sellRouter, token.address, TRADE_USDC);

      if (profitPct < MIN_PROFIT_PCT) {
        console.log(`Skipped ${token.symbol} ${buyName}->${sellName} | ProfitPct:${profitPct.toFixed(2)}% | EstNet💰:${profit.toFixed(6)}`);
        continue;
      }

      try {
        const result = await simulateAndExecute(buyRouter, sellRouter, token, amountInUSDC_BN, minReturnUSDC_BN);
        console.log(`✅ Executed ${token.symbol} ${buyName}->${sellName} | Profit: ${result.profitReal}`);
        if (result.decodedEvent) console.log("Event:", result.decodedEvent);
      } catch (e) {
        console.log(`⚠️ Execution failed for ${token.symbol} ${buyName}->${sellName}: ${e.message}`);
      }
    }
  }
}

// ---------------- RUN CONTINUOUSLY ----------------
async function startBot() {
  console.log("🚀 Starting continuous arb bot (every 10s)...");

  while (true) {
    try {
      await scanAndTrade();
    } catch (e) {
      console.error("Scan error:", e.message);
    }

    // Wait 10 seconds before next iteration
    await new Promise((resolve) => setTimeout(resolve, 10000));
  }
}

startBot();
