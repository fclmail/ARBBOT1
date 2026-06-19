// =========================================================================
// OPTIMIZATION: Cross-Exchange Matrix Mapping & Multi-Tier Discovery
// =========================================================================

function buildCrossExchangeTriangularPaths() {
    const tokenAddresses = Object.values(TOKENS);
    let generatedPaths = [];
    for (const a of tokenAddresses) {
        for (const b of tokenAddresses) {
            if (a === b) continue;
            generatedPaths.push({
                pathToToken: [USDC_ADDRESS, a, b],
                pathToUSDC: [b, USDC_ADDRESS]
            });
        }
    }
    return generatedPaths;
}

// Inside your block listener loop, replace the router nesting with this cross-pair strategy:
const triangularPaths = buildCrossExchangeTriangularPaths();

// Wider liquidity discovery distribution matching professional on-chain vaults
const capitalTiers = ["10", "50", "200", "500", "1200", "2500", "5000"]; 

// ... inside provider.on("block") ...
for (let pathObj of pathChunk) {
    // Generate asymmetric execution combinations
    const routerPairs = [
        { buyName: "QUICK", sellName: "SUSHI", buy: ROUTERS.QUICK, sell: ROUTERS.SUSHI },
        { buyName: "SUSHI", sellName: "QUICK", buy: ROUTERS.SUSHI, sell: ROUTERS.QUICK }
    ];

    for (let pair of routerPairs) {
        for (let tier of capitalTiers) {
            const testAmountIn = ethers.parseUnits(tier, 6);
            
            scanPromises.push(
                vaultContract.simulateArbitrageProfit(
                    pair.buy,
                    pair.sell,
                    testAmountIn,
                    pathObj.pathToToken,
                    pathObj.pathToUSDC
                )
                .then(([estimatedFinalUSDC, estimatedProfit]) => {
                    const isProfitable = estimatedProfit > 0n;
                    const lossDelta = !isProfitable ? (testAmountIn > estimatedFinalUSDC ? testAmountIn - estimatedFinalUSDC : 0n) : 0n;
                    
                    return {
                        success: true,
                        routeStr: `${pair.buyName}->${pair.sellName}`,
                        pair,
                        tier,
                        isProfitable,
                        estimatedProfit,
                        displayDelta: isProfitable 
                            ? `+${ethers.formatUnits(estimatedProfit, 6)}` 
                            : `-${ethers.formatUnits(lossDelta, 6)}`,
                        testAmountIn,
                        pathObj
                    };
                })
                .catch(() => ({ success: false }))
            );
        }
    }
}
