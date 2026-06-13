import dotenv from "dotenv";
import { ethers } from "ethers";
dotenv.config({ override: false });

/* ================= CONFIGURATION ================= */
// Instead of a single static number, define the step allocations
const MIN_MULTIPLIER_SIZE = ethers.parseUnits("0.02", 6);  // Floor test size ($0.02)
const MULTIPLIER_STEPS = 5;                              // Generate 5 candidate size levels
const BATCH_SIZE = 2; 
const MIN_PROFIT_PER_TRADE = ethers.parseUnits("0.000001", 6);

// ... Keep your standard parameters, RPCS, TOKENS, and routers dictionaries intact ...

/* ================= UPDATE ENGINE TO CALCULATE CANDIDATE MULTIPLIERS ================= */
async function sendRawBatchToContract(trades) {
    const deadline = Math.floor(Date.now() / 1000) + 120;
    
    try {
        // 1. Check current contract balance to establish the absolute ceiling for multipliers
        const currentContractBalance = await usdcContract.balanceOf(CONTRACT_ADDRESS);
        
        // If contract is drained below the floor size, skip to avoid division/loop issues
        if (currentContractBalance < MIN_MULTIPLIER_SIZE) {
            console.log("⚠️ SIMULATION SKIPPED: Contract balance is lower than minimum trade step size.");
            return;
        }

        // 2. Generate a dynamic dynamic candidate sizing matrix up to current maximum balance
        // This array matches the calldata structure of `uint256[] calldata candidateSizes` in your SC
        const dynamicCandidates = [];
        const maxChunkSize = currentContractBalance / BigInt(BATCH_SIZE); // Keep safety buffer for parallel batch loops
        const stepDelta = (maxChunkSize - MIN_MULTIPLIER_SIZE) / BigInt(MULTIPLIER_STEPS > 1 ? MULTIPLIER_STEPS - 1 : 1);

        for (let i = 0; i < MULTIPLIER_STEPS; i++) {
            const size = MIN_MULTIPLIER_SIZE + (stepDelta * BigInt(i));
            if (size <= maxChunkSize && size > 0n) {
                dynamicCandidates.push(size);
            }
        }

        console.log(`📡 Simulating ${trades.length} routes using dynamic multipliers: [${dynamicCandidates.map(c => ethers.formatUnits(c, 6)).join(", ")}] USDC`);

        let optimizedBatchTrades = [];
        let batchValid = true;

        // 3. Simulating off-chain which multiplier yields optimal extraction
        for (let i = 0; i < trades.length; i++) {
            const trade = trades[i];
            let bestTradeProfit = 0n;
            let optimalSizeForRoute = MIN_MULTIPLIER_SIZE;

            try {
                const routerContract = new ethers.Contract(trade.buyRouter, routerAbi, provider);
                
                // Test each scale multiplier locally in JS first
                for (const candidateSize of dynamicCandidates) {
                    const buyAmounts = await routerContract.getAmountsOut(candidateSize, trade.pathToToken);
                    const tokenBAmount = buyAmounts[buyAmounts.length - 1];
                    
                    const sellAmounts = await routerContract.getAmountsOut(tokenBAmount, trade.pathToUSDC);
                    const finalUSDC = sellAmounts[sellAmounts.length - 1];
                    
                    const tradeProfit = finalUSDC > candidateSize ? (finalUSDC - candidateSize) : 0n;
                    
                    // Track which multiplier generates the highest return before hitting AMM slippage cliffs
                    if (tradeProfit > bestTradeProfit) {
                        bestTradeProfit = tradeProfit;
                        optimalSizeForRoute = candidateSize;
                    }
                }

                if (bestTradeProfit < MIN_PROFIT_PER_TRADE) {
                    console.log(`静态 filtering: Trade #${i + 1} fails minimum profit floor at all multiplier levels.`);
                    batchValid = false;
                    break;
                }

                // Append the optimal calculated size to this explicit transaction layout
                optimizedBatchTrades.push({
                    ...trade,
                    calculatedOptimalSize: optimalSizeForRoute
                });

            } catch (err) {
                batchValid = false;
                break;
            }
        }

        if (!batchValid || optimizedBatchTrades.length !== trades.length) {
            console.log(`🛑 Aborting live pool broadcast: Multiplier path simulation unresolved.\n`);
            return;
        }

        // 4. Map the newly optimized candidate outputs into the exact structure expected by `executeFlashBatchArbitrage`
        const payload = {
            buyRouters: optimizedBatchTrades.map(t => t.buyRouter),
            sellRouters: optimizedBatchTrades.map(t => t.sellRouter),
            amountsInUSDC: optimizedBatchTrades.map(t => t.calculatedOptimalSize), // Direct optimal injection
            pathsToToken: optimizedBatchTrades.map(t => t.pathToToken),
            pathsToUSDC: optimizedBatchTrades.map(t => t.pathToUSDC),
            deadline: deadline
        };

        // 5. Normal Broadcast Pipeline
        await vault.executeFlashBatchArbitrage.staticCall(payload);
        const tx = await vault.executeFlashBatchArbitrage(payload, { gasLimit: 500000 });
        await tx.wait();
        
        console.log(`🔥 SUCCESS: Batch processed seamlessly using dynamic capital sizing.`);

    } catch (error) {
        console.log(`❌ BLOCK PASS REVERT: ${error.shortMessage || error.reason || "Slippage threshold violated"}`);
    }
}
