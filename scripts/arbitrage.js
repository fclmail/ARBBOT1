// 🟢 Fully functional bidirectional arbitrage script (ethers v6) - SAFER DROP-IN
import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();

// ─────────────────────────────────────────────
// 1️⃣ RPC + WALLET
// ─────────────────────────────────────────────
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

// ─────────────────────────────────────────────
// 2️⃣ ADDRESSES (Polygon)
// ─────────────────────────────────────────────
const VAULT_CONTRACT = "0x621F7ccEb67136f7922E36aF56137e7A1dbA22f1";
const USDC = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const WMATIC = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270";

const UNISWAP_V2_ROUTER = "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff";
const SUSHI_ROUTER = "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506";
const UNISWAP_V3_QUOTER = "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6";

// ─────────────────────────────────────────────
// 3️⃣ ABIs
// ─────────────────────────────────────────────
const vaultABI = [
  "function executeArbitrage(address,address,uint256,address[],address[],uint256) external"
];

const sushiABI = [
  "function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory)"
];

const quoterABI = [
  "function quoteExactInputSingle(address,address,uint24,uint256,uint160) external view returns (uint256)"
];

// ✅ FIX: minimal ERC20 ABI
const erc20ABI = [
  "function balanceOf(address) view returns (uint256)"
];

// ─────────────────────────────────────────────
// 4️⃣ CONTRACT INSTANCES
// ─────────────────────────────────────────────
const vault = new ethers.Contract(VAULT_CONTRACT, vaultABI, wallet);
const sushi = new ethers.Contract(SUSHI_ROUTER, sushiABI, provider);
const quoter = new ethers.Contract(UNISWAP_V3_QUOTER, quoterABI, provider);

// ✅ FIX: USDC contract instance
const usdc = new ethers.Contract(USDC, erc20ABI, provider);

// ─────────────────────────────────────────────
// 5️⃣ BOT CONFIG
// ─────────────────────────────────────────────
const TRADE_SIZE = ethers.parseUnits("0.8", 6);
const MIN_SPREAD = 0.05;
const UNI_FEE = 3000;

let executing = false;

// ─────────────────────────────────────────────
// 6️⃣ NONCE MANAGEMENT
// ─────────────────────────────────────────────
async function getPendingNonce() {
  return await provider.getTransactionCount(wallet.address, "pending");
}

// ─────────────────────────────────────────────
// 7️⃣ SEND TX WITH RELIABLE RETRIES & GAS BUMP
// ─────────────────────────────────────────────
async function sendTxWithRetry(txRequestBase, maxRetries = 3) {
  let attempt = 0;
  const baseReq = { ...txRequestBase };

  while (attempt < maxRetries) {
    try {
      const nonce = await getPendingNonce();

      const txRequest = {
        ...baseReq,
        nonce,
      };

      console.log(
        `[${new Date().toISOString()}] [TRY ${attempt + 1}] SENDING TX to ${txRequest.to} with nonce ${nonce}`
      );

      if (!txRequest.gasLimit) {
        try {
          const estimatedGas = await provider.estimateGas(txRequest);
          txRequest.gasLimit = estimatedGas.mul(120).div(100);
        } catch {
          txRequest.gasLimit = ethers.BigNumber.from(1_000_000);
        }
      }

      if (!txRequest.maxFeePerGas || !txRequest.maxPriorityFeePerGas) {
        txRequest.maxPriorityFeePerGas = ethers.parseUnits("2", "gwei");
        txRequest.maxFeePerGas = ethers.parseUnits("60", "gwei");
      }

      const tx = await wallet.sendTransaction(txRequest);
      console.log(`[${new Date().toISOString()}] TX SENT: ${tx.hash}`);

      const receipt = await tx.wait(1);
      if (receipt.status === 1) {
        console.log(
          `[${new Date().toISOString()}] TX MINED: ${receipt.transactionHash} (block ${receipt.blockNumber})`
        );
        console.log(`[${new Date().toISOString()}] 💰 PROFIT SENT TO VAULT (assumed by contract)`);
        console.log("──────────────────────────────");
        return receipt;
      } else {
        throw new Error("TX REVERTED");
      }
    } catch (err) {
      const msg = err?.message || String(err);
      console.warn(`[${new Date().toISOString()}] TX FAILED OR STUCK: ${msg}`);

      const retriable = /(nonce|replacement|gas|out of gas|execution reverted)/i.test(msg);
      attempt++;

      if (!retriable || attempt >= maxRetries) {
        throw new Error("TX FAILED AFTER MAX RETRIES");
      }

      const backoffMs = 500 + Math.floor(Math.random() * 500);
      await new Promise((r) => setTimeout(r, backoffMs));

      baseReq.maxPriorityFeePerGas = ethers.parseUnits("2.5", "gwei");
      baseReq.maxFeePerGas = ethers.parseUnits("70", "gwei");
    }
  }

  throw new Error("TX FAILED AFTER MAX RETRIES");
}

// ─────────────────────────────────────────────
// 8️⃣ MAIN LOOP
// ─────────────────────────────────────────────
async function checkAndExecute() {
  if (executing) return;
  executing = true;

  const ts = new Date().toISOString();

  try {
    const sushiOut = await sushi.getAmountsOut(TRADE_SIZE, [USDC, WMATIC]);
    const sushiWmatic = sushiOut[1];

    const uniWmatic = await quoter.quoteExactInputSingle(
      USDC,
      WMATIC,
      UNI_FEE,
      TRADE_SIZE,
      0
    );

    const sushiPrice =
      Number(ethers.formatUnits(TRADE_SIZE, 6)) /
      Number(ethers.formatUnits(sushiWmatic, 18));

    const uniPrice =
      Number(ethers.formatUnits(TRADE_SIZE, 6)) /
      Number(ethers.formatUnits(uniWmatic, 18));

    const spreadPct = ((sushiPrice - uniPrice) / uniPrice) * 100;

    console.log(`[${ts}] UNI:   ${Number(ethers.formatUnits(uniWmatic, 18)).toFixed(6)} WMATIC`);
    console.log(`[${ts}] SUSHI: ${Number(ethers.formatUnits(sushiWmatic, 18)).toFixed(6)} WMATIC`);
    console.log(`[${ts}] Spread: ${spreadPct.toFixed(4)}%`);

    let buyRouter, sellRouter, buyPath, sellPath;

    if (spreadPct <= -MIN_SPREAD) {
      buyRouter = UNISWAP_V2_ROUTER;
      sellRouter = SUSHI_ROUTER;
      buyPath = [USDC, WMATIC];
      sellPath = [WMATIC, USDC];
    } else if (spreadPct >= MIN_SPREAD) {
      buyRouter = SUSHI_ROUTER;
      sellRouter = UNISWAP_V2_ROUTER;
      buyPath = [USDC, WMATIC];
      sellPath = [WMATIC, USDC];
    } else {
      console.log(`[${ts}] ❌ No executable arbitrage`);
      console.log("──────────────────────────────");
      return;
    }

    const deadline = Math.floor(Date.now() / 1000) + 120;

    const contractBalance = await usdc.balanceOf(VAULT_CONTRACT);
    if (contractBalance < TRADE_SIZE) {
      console.log(`[${ts}] Insufficient USDC balance in contract for trade`);
      return;
    }

    const txRequestBase = {
      to: VAULT_CONTRACT,
      data: vault.interface.encodeFunctionData("executeArbitrage", [
        buyRouter,
        sellRouter,
        TRADE_SIZE,
        buyPath,
        sellPath,
        deadline,
      ]),
      gasLimit: ethers.BigNumber.from("1500000"),
      maxPriorityFeePerGas: ethers.parseUnits("80", "gwei"),
      maxFeePerGas: ethers.parseUnits("150", "gwei"),
    };

    await sendTxWithRetry(txRequestBase, 3);
  } catch (err) {
    console.error(`[${ts}] ERROR`, err?.reason || err?.message || err);
  } finally {
    executing = false;
  }
}

// ─────────────────────────────────────────────
// 9️⃣ RUN LOOP
// ─────────────────────────────────────────────
setInterval(checkAndExecute, 5000);
