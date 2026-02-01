import { ethers } from "ethers";
import fs from "fs";
import path from "path";

// Import the ABI files using fs or the new ESM import assert syntax
const arbitrageAbi = JSON.parse(
  fs.readFileSync(path.resolve("./abis/VaultArbitrageEnforcer.json"), "utf8")
);
const erc20Abi = JSON.parse(
  fs.readFileSync(path.resolve("./abis/ERC20.json"), "utf8")
);

// Set up your provider (use Infura or Alchemy for actual network)
const provider = new ethers.JsonRpcProvider("YOUR_INFURA_OR_ALCHEMY_URL");

// Set up wallet
const wallet = new ethers.Wallet("YOUR_PRIVATE_KEY", provider);

// Set up contracts
const vaultArbitrageEnforcerAddress = "VAULT_ARBITRAGE_ENFORCER_ADDRESS";
const vault = new ethers.Contract(vaultArbitrageEnforcerAddress, arbitrageAbi, wallet);

// Set up the USDC token contract (replace with correct USDC address)
const usdcAddress = "USDC_ADDRESS";
const usdc = new ethers.Contract(usdcAddress, erc20Abi, wallet);

// Minimum profit threshold in USDC (can adjust based on your requirement)
const minimumProfitUSDC = ethers.utils.parseUnits("1", 6); // 1 USDC = 1 * 10^6 for 6 decimals

// Arbitrage function
async function executeArbitrage(buyRouter, sellRouter, amountInUSDC, pathToToken, pathToUSDC, deadline) {
  try {
    console.log(`Executing Arbitrage from ${buyRouter} → ${sellRouter}...`);

    // Get the current balance of USDC
    const beforeBal = await usdc.balanceOf(vault.address);
    console.log(`Before Balance: ${ethers.utils.formatUnits(beforeBal, 6)} USDC`);

    // Perform on-chain arbitrage logic
    const tx = await vault.executeArbitrage(
      buyRouter,
      sellRouter,
      amountInUSDC,
      pathToToken,
      pathToUSDC,
      deadline
    );

    console.log(`TX SENT: ${tx.hash}`);

    // Wait for the transaction to be mined
    const receipt = await tx.wait();
    console.log(`Transaction mined in block: ${receipt.blockNumber}`);

    const afterBal = await usdc.balanceOf(vault.address);
    const profitUSDC = afterBal.sub(beforeBal);

    if (profitUSDC.gte(minimumProfitUSDC)) {
      console.log(`Profit is above threshold! Profit: ${ethers.utils.formatUnits(profitUSDC, 6)} USDC`);
      await usdc.transfer(vault.address, profitUSDC);
      console.log("Profit sent to vault!");
    } else {
      console.log("Profit below minimum threshold, no transfer made.");
    }

    // Emitting log after arbitrage completion
    console.log(`Arbitrage executed successfully. Profit: ${ethers.utils.formatUnits(profitUSDC, 6)} USDC`);
  } catch (err) {
    console.error("Arbitrage execution failed:", err);
  }
}

// Main function to check for arbitrage opportunities
async function checkArbitrageOpportunity() {
  try {
    const buyRouter = "SUSHI_ROUTER_ADDRESS";
    const sellRouter = "UNI_ROUTER_ADDRESS";
    const amountInUSDC = ethers.utils.parseUnits("1000", 6); // 1000 USDC as input
    const pathToToken = ["USDC_ADDRESS", "TOKEN_ADDRESS"]; // USDC -> Token path
    const pathToUSDC = ["TOKEN_ADDRESS", "USDC_ADDRESS"]; // Token -> USDC path
    const deadline = Math.floor(Date.now() / 1000) + 60 * 20; // 20 minutes deadline

    // Fetch prices from both routers (this is for demonstration purposes)
    const uniPrice = await getPriceFromRouter("UNI_ROUTER_ADDRESS", pathToToken);
    const sushiPrice = await getPriceFromRouter("SUSHI_ROUTER_ADDRESS", pathToToken);

    console.log(`UNI Price: ${uniPrice} WMATIC`);
    console.log(`SUSHI Price: ${sushiPrice} WMATIC`);

    const spread = ((sushiPrice - uniPrice) / uniPrice) * 100; // Calculate arbitrage spread
    console.log(`Spread: ${spread.toFixed(2)}%`);

    // If spread is above a threshold, execute the arbitrage
    if (spread > 0.1) {
      console.log("Arbitrage Opportunity Found! Executing...");
      await executeArbitrage(buyRouter, sellRouter, amountInUSDC, pathToToken, pathToUSDC, deadline);
    } else {
      console.log("No significant arbitrage opportunity found.");
    }
  } catch (err) {
    console.error("Error while checking for arbitrage opportunities:", err);
  }
}

// Helper function to fetch price from a router (example with Uniswap/SushiSwap)
async function getPriceFromRouter(routerAddress, path) {
  const router = new ethers.Contract(routerAddress, erc20Abi, provider);
  const amountsOut = await router.getAmountsOut(ethers.utils.parseUnits("1", 6), path);
  return ethers.utils.formatUnits(amountsOut[amountsOut.length - 1], 18); // Return price in token decimals
}

// Start the bot
checkArbitrageOpportunity();

// For continuous monitoring, you can set this inside a setInterval or similar
// setInterval(checkArbitrageOpportunity, 10000); // Run every 10 seconds
