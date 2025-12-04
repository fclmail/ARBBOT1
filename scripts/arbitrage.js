import { ethers } from "ethers";

// ---------------- CONFIG ----------------
if (!process.env.RPC_URL) throw new Error("Set RPC_URL in env");
if (!process.env.PRIVATE_KEY && process.env.DRY_RUN !== "true") {
  throw new Error("Set PRIVATE_KEY or run in DRY_RUN mode");
}

const RPC_URL = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY || "";
const DRY_RUN = (process.env.DRY_RUN || "false").toLowerCase() === "true";

const VAULT_ADDRESS = "0x7DadE334120e659eDE4999c8813c183648b1bd19";
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

const TRADE_USDC = 1;              // 1 USDC per trade
const MIN_PROFIT_PCT = 0.0002;     // 0.02% minimum profit
const USDC_DECIMALS = 6;

// Simple gas/fee placeholder in USDC units
const ESTIMATED_GAS_COST_USDC = 0.001; // adjust as needed

// ---------------- PROVIDER & WALLET ----------------
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = DRY_RUN ? null : new ethers.Wallet(PRIVATE_KEY, provider);

// ---------------- CONTRACT ABIs ----------------
const vaultABI = [
  "function executeArbitrage(address buyRouter,address sellRouter,address token,uint256 amountIn,uint256 minReturnUSDC) external",
  "function USDC() view returns(address)",
  "function owner() view returns(address)"
];
const routerABI = [
  "function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory)"
];
const erc20Abi = ["function balanceOf(address) view returns (uint256)"];

// ---------------- CONTRACT INSTANCES ----------------
const vaultContract = new ethers.Contract(VAULT_ADDRESS, vaultABI, wallet || provider);

// ---------------- ROUTERS & TOKENS ----------------
const routers = {
  QuickSwap: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
  SushiSwap: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506"
};

const tokens = {
  WETH: { address: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", decimals: 18 },
  WBTC: { address: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6", decimals: 8 },
  CRV:  { address: "0x172370d5Cd63279eFa6d502Dab29171933a610Af", decimals: 18 }
};

// ---------------- HELPERS ----------------
const toUSDCbn = (n) => ethers.parseUnits(n.toString(), USDC_DECIMALS);
const fromUSDCbn = (bn) => Number(ethers.formatUnits(bn, USDC_DECIMALS));
const toDisplay = (n, d = 6) => Number(n).toFixed(d);

// ---------------- UTILS ----------------
async function getVaultUSDCBalanceBN() {
  const usdcAddr = await vaultContract.USDC();
  const usdc = new ethers.Contract(usdcAddr, erc20Abi, provider);
  return await usdc.balanceOf(VAULT_ADDRESS);
}

// Compute expected profit for a trade
async function getExpectedProfit(buyRouterAddr, sellRouterAddr, tokenObj, tradeAmountUSDC) {
  const buyRouter = new ethers.Contract(buyRouterAddr, routerABI, provider);
  const sellRouter = new ethers.Contract(sellRouterAddr, routerABI, provider);

  const amountInBN = toUSDCbn(tradeAmountUSDC);

  const buyPath = [USDC_ADDRESS, tokenObj.address];
  const sellPath = [tokenObj.address, USDC_ADDRESS];

  try {
    const bought = await buyRouter.getAmountsOut(amountInBN, buyPath);
    const tokenAmountBN = bought[bought.length - 1];

    const sold = await sellRouter.getAmountsOut(tokenAmountBN, sellPath);
    const usdcOutBN = sold[sold.length - 1];

    const profitBN = usdcOutBN.sub(amountInBN);
    const profitUSDC = fromUSDCbn(profitBN);
    const profitPct = profitUSDC / tradeAmountUSDC;

    return { profitUSDC, profitPct, amountInBN, usdcOutBN };
  } catch (e) {
    console.error("Profit calc error:", e?.message ?? e);
    return { profitUSDC: -9999, profitPct: -9999, amountInBN, usdcOutBN: ethers.BigNumber.from(0) };
  }
}

// Simulate and execute arbitrage
async function simulateAndExecute(buyRouterAddr, sellRouterAddr, tokenObj, amountInBN, minReturnUSDCBN) {
  try {
    await vaultContract.callStatic.executeArbitrage(
      buyRouterAddr,
      sellRouterAddr,
      tokenObj.address,
      amountInBN,
      minReturnUSDCBN
    );
  } catch (e) {
    throw new Error(`Simulation failed: ${e?.message ?? e}`);
  }

  if (DRY_RUN) return { txHash: null, profitRealUSDC: 0 };

  const before = await getVaultUSDCBalanceBN();

  let txOpts = { gasLimit: 1_200_000 };
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
    buyRouterAddr,
    sellRouterAddr,
    tokenObj.address,
    amountInBN,
    minReturnUSDCBN,
    txOpts
  );
  console.log(`TX sent: ${tx.hash}`);
  const receipt = await tx.wait();

  const after = await getVaultUSDCBalanceBN();
  const profitRealUSDC = fromUSDCbn(after.sub(before));

  return { txHash: tx.hash, profitRealUSDC, receipt };
}

// ---------------- MAIN LOOP ----------------
async function mainLoop() {
  const tokenList = [tokens.WETH, tokens.WBTC, tokens.CRV];

  console.log(`🚀 Starting continuous arb bot (DRY_RUN=${DRY_RUN})...`);

  while (true) {
    try {
      for (const tokenObj of tokenList) {
        const routerEntries = Object.entries(routers);
        for (const [buyName, buyAddr] of routerEntries) {
          for (const [sellName, sellAddr] of routerEntries) {
            if (buyAddr.toLowerCase() === sellAddr.toLowerCase()) continue;

            const { profitUSDC, profitPct, amountInBN } =
              await getExpectedProfit(buyAddr, sellAddr, tokenObj, TRADE_USDC);

            const netProfitUSDC = profitUSDC - ESTIMATED_GAS_COST_USDC;
            const netProfitPct = netProfitUSDC / TRADE_USDC;

            console.log(
              `SCAN: Buy=${buyName} Sell=${sellName} Token=${tokenObj.address} ` +
              `TRADE_USDC=${TRADE_USDC} grossProfitUSDC=${toDisplay(profitUSDC)} ` +
              `profitPct=${(profitPct * 100).toFixed(4)}% netProfitUSDC=${toDisplay(netProfitUSDC)} ` +
              `netProfitPct=${(netProfitPct * 100).toFixed(4)}%`
            );

            if (netProfitUSDC > 0 && profitPct >= MIN_PROFIT_PCT) {
              console.log(`✅ ARB VIABLE (net positive). Attempting execution...`);
              try {
                const { txHash, profitRealUSDC, receipt } = await simulateAndExecute(
                  buyAddr, sellAddr, tokenObj, amountInBN, toUSDCbn(TRADE_USDC)
                );
                console.log(`ARB RESULT -> txHash=${txHash ?? "N/A"} RealProfitUSDC=${toDisplay(profitRealUSDC)}`);
                if (receipt) console.log(`TX mined: block ${receipt.blockNumber}, status ${receipt.status}`);
              } catch (e) {
                console.error(`Arb execution failed: ${e?.message ?? e}`);
              }
            } else {
              console.log(`ARB SKIPPED: netProfitUSDC=${toDisplay(netProfitUSDC)} USDC`);
            }

            // Gentle pacing between pairs
            await new Promise(r => setTimeout(r, 100));
          }
        }
      }
    } catch (err) {
      console.error(`Error in mainLoop: ${err?.message ?? err}`);
    }

    // Sleep 10s before next full scan
    await new Promise(r => setTimeout(r, 10000));
  }
}

// ---------------- START ----------------
mainLoop().catch(err => {
  console.error(`Fatal error: ${err?.message ?? err}`);
  process.exit(1);
});
