import fs from 'fs';
import path from 'path';
import { ethers } from 'ethers';

// ABI and contract addresses
const arbitrageAbiPath = path.resolve("./abis/VaultArbitrageEnforcer.json");

if (!fs.existsSync(arbitrageAbiPath)) {
    console.error("Error: ABI file not found at", arbitrageAbiPath);
    process.exit(1);
}

const arbitrageAbi = JSON.parse(fs.readFileSync(arbitrageAbiPath, "utf8"));

// Set up your provider (Infura/Alchemy or local Ethereum node)
const provider = new ethers.JsonRpcProvider('YOUR_PROVIDER_URL');
const wallet = new ethers.Wallet('YOUR_PRIVATE_KEY', provider);

// Vault address (where profits will be sent)
const vaultAddress = 'YOUR_VAULT_ADDRESS';

// Arbitrage contract address
const arbitrageContractAddress = 'YOUR_CONTRACT_ADDRESS';

// Set up the contract instance
const arbitrageContract = new ethers.Contract(
  arbitrageContractAddress, 
  arbitrageAbi, 
  wallet
);

// Function to execute the arbitrage trade
async function executeArbitrage(buyRouter, sellRouter, amountInUSDC, pathToToken, pathToUSDC, deadline) {
  try {
    // Check the balance of USDC before the trade
    const beforeBal = await provider.getBalance(wallet.address);
    console.log(`Before Balance: ${ethers.utils.formatUnits(beforeBal, 18)} USDC`);

    // Execute the arbitrage on-chain
    const tx = await arbitrageContract.executeArbitrage(
      buyRouter,
      sellRouter,
      amountInUSDC,
      pathToToken,
      pathToUSDC,
      deadline
    );

    console.log(`Transaction Sent: ${tx.hash}`);

    // Wait for the transaction to be mined
    const receipt = await tx.wait();
    console.log(`Transaction Mined: ${receipt.transactionHash}`);

    // Check the balance of USDC after the trade
    const afterBal = await provider.getBalance(wallet.address);
    console.log(`After Balance: ${ethers.utils.formatUnits(afterBal, 18)} USDC`);

    // Calculate the profit
    const profitUSDC = ethers.utils.formatUnits(afterBal.sub(beforeBal), 18);
    console.log(`Profit: ${profitUSDC} USDC`);

    // If profit is greater than 0, send the profit to the vault
    if (parseFloat(profitUSDC) > 0) {
      const txTransfer = await wallet.sendTransaction({
        to: vaultAddress,
        value: ethers.utils.parseUnits(profitUSDC, 18),
      });

      console.log(`Profit sent to vault: ${txTransfer.hash}`);

      // Wait for the transfer to complete
      await txTransfer.wait();
      console.log("Profit successfully sent to vault.");
    }
  } catch (error) {
    console.error("Error executing arbitrage:", error);
  }
}

// Example parameters for the arbitrage (update with real values)
const buyRouter = 'BUY_ROUTER_ADDRESS';
const sellRouter = 'SELL_ROUTER_ADDRESS';
const amountInUSDC = ethers.utils.parseUnits('1000', 6); // 1000 USDC
const pathToToken = ['USDC_ADDRESS', 'TOKEN_ADDRESS'];  // Example token path
const pathToUSDC = ['TOKEN_ADDRESS', 'USDC_ADDRESS'];  // Example reverse path
const deadline = Math.floor(Date.now() / 1000) + 60 * 20; // 20 minutes from now

// Execute the arbitrage
executeArbitrage(buyRouter, sellRouter, amountInUSDC, pathToToken, pathToUSDC, deadline);
