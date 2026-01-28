const { ethers } = require("ethers");
const axios = require("axios");

async function executeArbitrage() {
  // Define provider and wallet
  const provider = new ethers.JsonRpcProvider("YOUR_RPC_URL");
  const wallet = new ethers.Wallet("YOUR_PRIVATE_KEY", provider);

  // Contract details
  const contractAddress = "YOUR_CONTRACT_ADDRESS";
  const contractABI = [ /* Your contract ABI here */ ];
  const contract = new ethers.Contract(contractAddress, contractABI, wallet);

  // Define gas parameters
  const maxPriorityFeePerGas = ethers.utils.parseUnits("80", "gwei"); // 80 gwei
  const maxFeePerGas = ethers.utils.parseUnits("150", "gwei"); // 150 gwei

  // Get the latest nonce
  const nonce = await provider.getTransactionCount(wallet.address, "latest");

  // Fetch arbitrage data (example with axios, adjust API URL as needed)
  const response = await axios.get('API_URL_TO_GET_PRICE_DETAILS');
  const data = response.data;

  const uniPrice = data.uniPrice;
  const sushiPrice = data.sushiPrice;
  const minProfit = 0.000001; // Minimum profit in WMATIC (adjust this threshold)

  // Calculate spread (price difference percentage)
  const spread = (sushiPrice - uniPrice) / uniPrice * 100;

  console.log(`UNI:   ${uniPrice} WMATIC`);
  console.log(`SUSHI: ${sushiPrice} WMATIC`);
  console.log(`Spread: ${spread.toFixed(4)}%`);

  // Check if there is a valid arbitrage opportunity
  if (spread > 0 && (sushiPrice - uniPrice) > minProfit) {
    console.log("✅ ARBITRAGE FOUND (SUSHI → UNI)");

    try {
      // Execute the arbitrage transaction (replace with actual parameters for your contract swap)
      const tx = await contract.swap(
        // Your contract swap parameters here (e.g., amountIn, amountOutMin, path)
        {
          nonce: nonce,
          maxPriorityFeePerGas: maxPriorityFeePerGas,
          maxFeePerGas: maxFeePerGas,
        }
      );

      console.log(`TX SENT: ${tx.hash}`);

      // Wait for the transaction to be mined with a timeout (e.g., 2 confirmations)
      const timeout = 60000; // 1 minute timeout
      const txReceipt = await Promise.race([
        tx.wait(2), // Wait for 2 confirmations
        new Promise((_, reject) => setTimeout(() => reject(new Error('Transaction timed out')), timeout))
      ]);

      console.log(`TX SUCCESS: ${txReceipt.transactionHash}`);
    } catch (err) {
      console.error("Error executing arbitrage:", err);
      // Retry or log the error for further analysis
    }
  } else {
    console.log("❌ No executable arbitrage");
  }
}

// Run arbitrage every 5 seconds
setInterval(executeArbitrage, 5000);
