// arbitrage.js
import { ethers } from "ethers";
import arbitrageAbi from "../abis/VaultArbitrageEnforcer.json"; // your contract ABI
import erc20Abi from "../abis/ERC20.json"; // ERC20 ABI

// ---------------- CONFIG ---------------- //
const RPC_URL = "https://polygon-mainnet.g.alchemy.com/v2/YOUR_KEY"; // use reliable RPC
const PRIVATE_KEY = "YOUR_WALLET_PRIVATE_KEY";
const CONTRACT_ADDRESS = "YOUR_VAULT_ARBITRAGE_ENFORCER_ADDRESS";
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"; // Polygon USDC
const SLIPPAGE = 0.995; // 0.5% slippage

// Routers
const UNISWAP_ROUTER = "0x1F98431c8aD98523631AE4a59f267346ea31F984"; 
const SUSHI_ROUTER = "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506"; 

// Tokens
const WMATIC = "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270";
const UNI = "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984";
const SUSHI = "0x6b3595068778dd592e39a122f4f5a5cf09c90fe2";

// Amount in USDC per arbitrage
const AMOUNT_USDC = ethers.utils.parseUnits("1000", 6); // 1000 USDC

// ---------------- SETUP PROVIDER & WALLET ---------------- //
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const vaultContract = new ethers.Contract(CONTRACT_ADDRESS, arbitrageAbi, wallet);
const usdc = new ethers.Contract(USDC_ADDRESS, erc20Abi, wallet);

// ---------------- NONCE MANAGEMENT ---------------- //
let noncePromise = provider.getTransactionCount(wallet.address, "pending");
async function getNonce() {
  const currentNonce = await noncePromise;
  noncePromise = currentNonce + 1;
  return currentNonce;
}

// ---------------- TX SEND WITH RETRY ---------------- //
async function sendTxWithRetry(txRequest, maxRetries = 3) {
  let attempt = 0;
  while (attempt < maxRetries) {
    try {
      txRequest.nonce = await getNonce();
      const tx = await wallet.sendTransaction(txRequest);
      console.log(`[${new Date().toISOString()}] TX SENT: ${tx.hash}`);

      // Non-blocking confirmation
      provider.once(tx.hash, (receipt) => {
        if (receipt && receipt.status === 1) {
          console.log(`[${new Date().toISOString()}] TX CONFIRMED: ${receipt.transactionHash}`);
        } else {
          console.log(`[${new Date().toISOString()}] TX FAILED: ${tx.hash}`);
        }
      });
      return tx;
    } catch (err) {
      console.log(`TX attempt ${attempt + 1} failed: ${err.message}`);
      if (!txRequest.maxPriorityFeePerGas) txRequest.maxPriorityFeePerGas = ethers.parseUnits("2", "gwei");
      txRequest.maxPriorityFeePerGas *= 2;
      txRequest.maxFeePerGas *= 2;
      attempt++;
    }
  }
  throw new Error("TX FAILED AFTER MAX RETRIES");
}

// ---------------- APPROVE TOKENS ---------------- //
async function approveRouters() {
  const routers = [UNISWAP_ROUTER, SUSHI_ROUTER];
  for (const router of routers) {
    const allowance = await usdc.allowance(wallet.address, router);
    if (allowance.lt(AMOUNT_USDC)) {
      console.log(`Approving ${router} for USDC...`);
      const tx = await sendTxWithRetry(await usdc.populateTransaction.approve(router, ethers.MaxUint256));
      await tx.wait();
      console.log(`Approved ${router}`);
    }
  }
}

// ---------------- EXECUTE ARBITRAGE ---------------- //
let executing = false;
async function executeArbitrage(buyRouter, sellRouter, pathToToken, pathToUSDC) {
  if (executing) return;
  executing = true;
  try {
    // Check USDC balance
    const balance = await usdc.balanceOf(wallet.address);
    if (balance.lt(AMOUNT_USDC)) {
      console.log("Insufficient USDC for arbitrage");
      return;
    }

    const deadline = Math.floor(Date.now() / 1000) + 60; // 1 min
    const txRequest = await vaultContract.populateTransaction.executeArbitrage(
      buyRouter,
      sellRouter,
      AMOUNT_USDC,
      pathToToken,
      pathToUSDC,
      deadline
    );

    // Gas settings
    txRequest.maxPriorityFeePerGas = ethers.parseUnits("2", "gwei");
    txRequest.maxFeePerGas = ethers.parseUnits("100", "gwei"); // adjust dynamically if needed

    await sendTxWithRetry(txRequest);

  } catch (err) {
    console.log(`Arbitrage failed: ${err.message}`);
  } finally {
    executing = false;
  }
}

// ---------------- MAIN LOOP ---------------- //
async function main() {
  await approveRouters();

  while (true) {
    try {
      // Fetch prices from your logic (replace below with your actual arbitrage detection)
      const uniPrice = Math.random() * 0.001 + 0.106; // simulate
      const sushiPrice = Math.random() * 0.001 + 0.106;

      const spread = ((sushiPrice - uniPrice) / uniPrice) * 100;
      if (spread > 0.2) { // example threshold
        console.log(`[${new Date().toISOString()}] ✅ ARBITRAGE FOUND (UNI → SUSHI) Spread: ${spread.toFixed(4)}%`);
        await executeArbitrage(UNISWAP_ROUTER, SUSHI_ROUTER, [USDC_ADDRESS, UNI], [UNI, USDC_ADDRESS]);
      } else if (spread < -0.2) {
        console.log(`[${new Date().toISOString()}] ✅ ARBITRAGE FOUND (SUSHI → UNI) Spread: ${spread.toFixed(4)}%`);
        await executeArbitrage(SUSHI_ROUTER, UNISWAP_ROUTER, [USDC_ADDRESS, SUSHI], [SUSHI, USDC_ADDRESS]);
      } else {
        console.log(`[${new Date().toISOString()}] No profitable arbitrage. Spread: ${spread.toFixed(4)}%`);
      }

      await new Promise(res => setTimeout(res, 5000)); // 5s loop
    } catch (err) {
      console.log(`Main loop error: ${err.message}`);
      await new Promise(res => setTimeout(res, 5000));
    }
  }
}

main();
