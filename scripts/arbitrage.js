import { config } from 'dotenv'
import { ethers } from 'ethers'

// Load environment variables from .env
config()

/* ================= CONFIG ================= */
const RPC = process.env.RPC_URL
const PRIVATE_KEY = process.env.PRIVATE_KEY

const CONTRACT_ADDRESS = "0x11887399855F0657cCd6018ca3A9aDa6Ac87664E"

const provider = new ethers.JsonRpcProvider(RPC)
const wallet = new ethers.Wallet(PRIVATE_KEY, provider)

const contract = new ethers.Contract(
  CONTRACT_ADDRESS,
  require('./abi.json'), // ABI file path
  wallet
)

/* ================= BATCH SETTINGS ================= */
const MIN_BATCH_SIZE = 3
const MAX_WAIT_MS = 1200
const GAS_BUFFER = 1.3 // Threshold for gas optimization (profit > gas buffer)
const PROFIT_THRESHOLD = 0.0001 // Minimum profit to include in batch (USDC)

let pendingBatch = []
let lastFlushTime = Date.now()

/* ================= SCANNING LOOP ================= */
async function scanningLoop() {
  console.log("Starting Flash Micro-Batch Scanner...")

  while (true) {
    try {
      const route = await findOpportunity()

      if (route && route.profitable) {
        console.log("Profit found:", route.expectedProfit)

        // Check if profit exceeds the threshold before pushing to batch
        if (parseFloat(route.expectedProfit) >= PROFIT_THRESHOLD) {
          pendingBatch.push({
            buyRouter: route.buyRouter,
            sellRouter: route.sellRouter,
            amountInUSDC: route.amountInUSDC,
            pathToToken: route.pathToToken,
            pathToUSDC: route.pathToUSDC,
            deadline: Math.floor(Date.now() / 1000) + 60
          })
        }
      }

      const timeExpired = Date.now() - lastFlushTime > MAX_WAIT_MS

      // Batch execute if we hit the minimum size or time window expired
      if (
        pendingBatch.length >= MIN_BATCH_SIZE ||
        (timeExpired && pendingBatch.length > 0)
      ) {
        await executeFlashBatch(pendingBatch)

        pendingBatch = []
        lastFlushTime = Date.now()
      }
    } catch (err) {
      console.error("Scan error:", err.message)
    }
  }
}

/* ================= FLASH EXECUTION ================= */
async function executeFlashBatch(batch) {
  try {
    console.log(`Executing flash batch of ${batch.length} trades...`)

    // Calculate total flash loan amount required for the batch
    const totalFlashAmount = batch.reduce(
      (sum, arb) => sum + BigInt(arb.amountInUSDC),
      0n
    )

    // Simulate the batch execution to ensure it's profitable and can succeed
    const simulated = await simulateFlashExecution(batch, totalFlashAmount)

    if (!simulated.success) {
      console.log("Simulation failed, skipping batch.")
      return
    }

    const tx = await contract.executeFlashUnlimitedBatch(
      batch,
      totalFlashAmount,
      {
        gasLimit: 8_000_000
      }
    )

    console.log("Flash Batch Sent:", tx.hash)

    const receipt = await tx.wait()

    console.log("Flash Batch Confirmed")

    // Log each arbitrage executed
    for (const log of receipt.logs) {
      try {
        const parsed = contract.interface.parseLog(log)
        if (parsed.name === "ArbitrageExecuted") {
          console.log("Arb Profit:",
            ethers.formatUnits(parsed.args.profitUSDC, 6),
            "USDC"
          )
        }
      } catch {}
    }
  } catch (err) {
    console.error("Flash batch failed:", err.reason || err.message)
  }
}

/* ================= SIMULATE FLASH EXECUTION ================= */
async function simulateFlashExecution(batch, totalFlashAmount) {
  try {
    // Use callStatic to simulate the execution
    const result = await contract.callStatic.executeFlashUnlimitedBatch(
      batch,
      totalFlashAmount
    )

    return { success: true, result }
  } catch (err) {
    console.error("Simulation failed:", err.message)
    return { success: false }
  }
}

/* ================= MOCK FIND OPPORTUNITY ================= */
/* Replace with your real scanning logic */
async function findOpportunity() {
  // Simulate scanning for arbitrage opportunities
  return {
    profitable: Math.random() > 0.7,
    expectedProfit: (Math.random() * 0.001).toFixed(6),  // Simulated profit
    buyRouter: "0xRouterA",
    sellRouter: "0xRouterB",
    amountInUSDC: ethers.parseUnits("100", 6),
    pathToToken: [
      "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
      "0xToken"
    ],
    pathToUSDC: [
      "0xToken",
      "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"
    ]
  }
}

/* ================= START ================= */
scanningLoop()
