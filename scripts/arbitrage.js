// arbitrage.js
const { ethers } = require("ethers");
const abi = require("./abi.json"); // Your contract ABI
const config = require("./config.json"); // Your config with addresses, RPC, wallet

// --- Setup provider and wallet ---
const provider = new ethers.JsonRpcProvider(config.rpc);
const wallet = new ethers.Wallet(config.privateKey, provider);

// --- Setup contract ---
const contract = new ethers.Contract(config.contractAddress, abi, wallet);

// --- Timeout helper ---
function txWithTimeout(txPromise, timeoutMs = 15000) {
  return Promise.race([
    txPromise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("TX WAIT TIMEOUT")), timeoutMs)
    ),
  ]);
}

// --- Function to handle resubmission of stalled transactions ---
async function resendStalledTx(txHash, nonce, gasPrice) {
  console.log(`Resubmitting stalled transaction with nonce ${nonce}`);
  const tx = await contract.swap(/* swap params */, {
    nonce: nonce,
    maxPriorityFeePerGas: gasPrice.maxPriorityFeePerGas,
    maxFeePerGas: gasPrice.maxFeePerGas,
  });

  console.log("Resubmitted TX SENT:", tx.hash);
  return tx.wait(1); // Wait for the transaction to be mined
}

// --- Main arbitrage function ---
async function runArbitrage() {
  try {
    // --- Example: get token prices ---
    const uniPrice = await getUniPrice();   // Implemented elsewhere
    const sushiPrice = await getSushiPrice(); // Implemented elsewhere
    const spread = ((sushiPrice - uniPrice) / uniPrice) * 100;

    console.log(`UNI:   ${uniPrice} WMATIC`);
    console.log(`SUSHI: ${sushiPrice} WMATIC`);
    console.log(`Spread: ${spread.toFixed(4)}%`);

    // --- Check for arbitrage opportunity ---
    if (spread > config.minProfit) {
      console.log("✅ ARBITRAGE FOUND (SUSHI → UNI)");
      console.log("EXECUTING ON-CHAIN...");

      // Prepare for transaction submission
      const nonce = await provider.getTransactionCount(wallet.address, "latest");
      const gasPrice = {
        maxPriorityFeePerGas: ethers.utils.parseUnits("80", "gwei"),
        maxFeePerGas: ethers.utils.parseUnits("150", "gwei"),
      };

      const tx = await contract.swap(/* swap params */, {
        nonce: nonce,
        maxPriorityFeePerGas: gasPrice.maxPriorityFeePerGas,
        maxFeePerGas: gasPrice.maxFeePerGas,
      });

      console.log("TX SENT:", tx.hash);

      try {
        const receipt = await txWithTimeout(tx.wait(1), 15000); // Wait 1 confirmation, timeout after 15s
        console.log("TX CONFIRMED:", receipt.transactionHash);
        console.log("💰 PROFIT SENT TO VAULT");
      } catch (err) {
        console.warn("⚠️ TX STALLED OR TIMEOUT:", err.message);
        
        // If transaction is stalled or timed out, resend with the same nonce but higher gas
        const newGasPrice = {
          maxPriorityFeePerGas: ethers.utils.parseUnits("100", "gwei"),
          maxFeePerGas: ethers.utils.parseUnits("200", "gwei"),
        };

        await resendStalledTx(tx.hash, nonce, newGasPrice);
      }
    } else {
      console.log("❌ No executable arbitrage");
    }
  } catch (err) {
    console.error("ERROR:", err.message);
  }
}

// --- Periodic run ---
setInterval(runArbitrage, config.pollIntervalMs);

// --- Placeholder functions ---
async function getUniPrice() {
  // Replace with actual price fetch logic
  return 0.118;
}

async function getSushiPrice() {
  // Replace with actual price fetch logic
  return 0.1185;
}

// --- Start ---
runArbitrage();
