import { ethers } from "ethers";

// ------------------------ CONFIG ------------------------

const PROVIDER_URL = process.env.PROVIDER_URL; // e.g., Alchemy/Infura RPC
const WALLET_PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY;

const VAULT_CONTRACT_ADDRESS = "0x621F7ccEb67136f7922E36aF56137e7A1dbA22f1";

// Router addresses (normalize to checksum)
const ROUTERS = {
    quickswap: ethers.getAddress("0xa5e0829caCED8FFDD4De3c43696c57F7D7A678ff"),
    sushi: ethers.getAddress("0xc0788a3ad43d79aa53b09c2eacc313a787d1d607"),
    pangolin: ethers.getAddress("0xa102072a4c07f06ec3b4900fdc4c7b80b6c57429")
};

// Example token paths
const PATHS = {
    USDC_TO_WETH: [
        ethers.getAddress("0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"), // USDC
        ethers.getAddress("0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619")  // WETH
    ],
    WETH_TO_USDC: [
        ethers.getAddress("0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619"), // WETH
        ethers.getAddress("0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174")  // USDC
    ]
};

const MIN_PROFIT_USDC = ethers.parseUnits("0.000001", 6); // 6 decimals for USDC
const AMOUNT_USDC = ethers.parseUnits("1.0", 6); // Amount to arbitrage
const SCAN_INTERVAL_MS = 5000;

// ------------------------ PROVIDER & WALLET ------------------------

const provider = new ethers.JsonRpcProvider(PROVIDER_URL);
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

// ------------------------ VAULT CONTRACT ------------------------

const VAULT_ABI = [
    "function executeArbitrage(address buyRouter, address sellRouter, uint256 amountInUSDC, address[] calldata pathToToken, address[] calldata pathToUSDC, uint256 deadline) external",
    "function setMinimumProfitUSDC(uint256 _min) external",
    "function approveRouter(address router, uint256 amount) external",
    "function routerAllowance(address router) view returns (uint256)"
];

const vaultContract = new ethers.Contract(VAULT_CONTRACT_ADDRESS, VAULT_ABI, wallet);

// ------------------------ UTILS ------------------------

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function approveRouterIfNeeded(router) {
    try {
        const allowance = await vaultContract.routerAllowance(router);
        if (allowance < AMOUNT_USDC) {
            console.log(`[${new Date().toISOString()}] Approving USDC for router ${router}`);
            const tx = await vaultContract.approveRouter(router, AMOUNT_USDC);
            await tx.wait();
            console.log(`[${new Date().toISOString()}] Router approved: ${router} (Tx: ${tx.hash})`);
            await sleep(500);
        }
    } catch (err) {
        console.log(`[${new Date().toISOString()}] Approval failed for ${router}: ${err?.reason || err?.message || err}`);
    }
}

// ------------------------ ARBITRAGE SCAN LOOP ------------------------

async function scanLoop() {
    const routers = Object.values(ROUTERS);

    console.log("✅ Setup complete. Starting scan loop...");

    while (true) {
        for (let i = 0; i < routers.length; i++) {
            for (let j = 0; j < routers.length; j++) {
                if (i === j) continue;

                const buyRouter = routers[i];
                const sellRouter = routers[j];

                try {
                    await vaultContract.executeArbitrage(
                        buyRouter,
                        sellRouter,
                        AMOUNT_USDC,
                        PATHS.USDC_TO_WETH,
                        PATHS.WETH_TO_USDC,
                        Math.floor(Date.now() / 1000) + 60 // deadline = 60s from now
                    );
                    console.log(`[${new Date().toISOString()}] ✅ Arbitrage executed: ${buyRouter} -> ${sellRouter}`);
                    await sleep(500);
                } catch (err) {
                    console.log(`[${new Date().toISOString()}] 💤 Skipped ${buyRouter} -> ${sellRouter}: ${err?.reason || err?.message || err}`);
                }
            }
        }

        console.log(`[${new Date().toISOString()}] Cycle complete. Restarting in ${SCAN_INTERVAL_MS / 1000}s...`);
        await sleep(SCAN_INTERVAL_MS);
    }
}

// ------------------------ MAIN ------------------------

async function main() {
    console.log("Starting arbitrage bot…");
    console.log(`✔ Wallet address: ${wallet.address}`);
    console.log(`Minimum profit enforced: ${ethers.formatUnits(MIN_PROFIT_USDC, 6)} USDC`);

    // Approve routers first
    for (const router of Object.values(ROUTERS)) {
        await approveRouterIfNeeded(router);
    }

    scanLoop();
}

main().catch(err => console.error(err));
