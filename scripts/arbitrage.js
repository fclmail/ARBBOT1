const { ethers } = require('ethers');
const axios = require('axios');

// Environment variables (ensure you have them set correctly)
const RPC_URL = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const BUY_ROUTER = process.env.BUY_ROUTER;
const SELL_ROUTER = process.env.SELL_ROUTER;
const TOKEN = process.env.TOKEN; // Token address for arbitrage
const AMOUNT_IN_HUMAN = process.env.AMOUNT_IN_HUMAN;
const USDC_ADDRESS = process.env.USDC_ADDRESS; // USDC contract address
const VAULT_ADDRESS = process.env.VAULT_ADDRESS; // Vault address
const MIN_PROFIT_USDC = ethers.utils.parseUnits("0.000001", 6); // Set min profit to 1 = 0.000001 USDC

// Initialize provider and wallet
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// Define the smart contract ABI (you can adjust this based on the contract ABI you provided)
const contractABI = [
    {
        "inputs": [],
        "name": "POOL",
        "outputs": [{ "internalType": "contract IPool", "name": "", "type": "address" }],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [
            { "internalType": "address", "name": "asset", "type": "address" },
            { "internalType": "uint256", "name": "amount", "type": "uint256" },
            { "internalType": "uint256", "name": "premium", "type": "uint256" },
            { "internalType": "address", "name": "initiator", "type": "address" },
            { "internalType": "bytes", "name": "params", "type": "bytes" }
        ],
        "name": "executeOperation",
        "outputs": [{ "internalType": "bool", "name": "", "type": "bool" }],
        "stateMutability": "nonpayable",
        "type": "function"
    }
];

const contractAddress = '0xAB046582A36D00f4921C447db9b77644b5e43c95'; // Contract address

// Instantiate contract
const contract = new ethers.Contract(contractAddress, contractABI, wallet);

// Helper function to fetch liquidity and vault balance
async function fetchLiquidity() {
    try {
        // Fetch liquidity details (assuming your contract has a method for this)
        const liquidity = await contract.POOL(); // Replace with actual call for liquidity if needed
        console.log(`🏦 AAVE USDC Liquidity: ${ethers.utils.formatUnits(liquidity, 18)}`);
    } catch (err) {
        console.error('Error fetching liquidity:', err);
    }
}

async function fetchVaultBalance() {
    try {
        // Fetch the vault's USDC balance
        const vault = new ethers.Contract(VAULT_ADDRESS, ['function balanceOf(address) view returns (uint256)'], provider);
        const vaultBalance = await vault.balanceOf(VAULT_ADDRESS);
        console.log(`🔹 Vault Balance: ${ethers.utils.formatUnits(vaultBalance, 6)} USDC`);
    } catch (err) {
        console.error('Error fetching vault balance:', err);
    }
}

// Function to perform the arbitrage logic
async function executeArbitrage() {
    try {
        console.log('🚀 Arbitrage bot started');

        // Fetch initial liquidity and vault balance
        await fetchLiquidity();
        await fetchVaultBalance();

        // Get the token price or arbitrage logic here
        // For example, if you use Uniswap, fetch token prices on the two routers.
        // You should fetch the liquidity from the relevant sources and check the price difference for arbitrage.

        const amountInUSDC = ethers.utils.parseUnits(AMOUNT_IN_HUMAN, 6); // Convert human-readable amount to USDC

        // This assumes you are performing arbitrage with the contract
        const tx = await contract.executeArbitrage(
            BUY_ROUTER,
            SELL_ROUTER,
            amountInUSDC,
            [TOKEN],  // Path to token on the buy router
            [USDC_ADDRESS],  // Path to USDC on the sell router
            Math.floor(Date.now() / 1000) + 60 * 10 // Deadline: 10 minutes from now
        );

        // Wait for transaction to be mined
        await tx.wait();

        console.log(`Transaction successful: ${tx.hash}`);

        // Fetch updated liquidity and vault balance after arbitrage
        await fetchLiquidity();
        await fetchVaultBalance();

    } catch (error) {
        console.error('Arbitrage failed:', error);
    }
}

// Execute the arbitrage
executeArbitrage();
