// ============================================================================  
// arbitrage.js — Continuous Full-Monitor Chonking Engine
// ============================================================================  

import { ethers } from "ethers";  

const CONFIG = {  
    rpcUrls: [process.env.RPC_URL || "https://polygon-rpc.com"],
    contractAddress: "0x7EAf60672B8c0A2399187bCa1BB916F14Ac7a958",  
    REQUEST_DELAY: 200, // ms delay to keep RPS below threshold
    CHONK_SIZE: 4       // Process 4 routes then breathe
};  

// ... [Keep your TOKENS/DEXES maps here] ...

class RealTimeArbitrageBot {  
    constructor() {  
        this.provider = new ethers.JsonRpcProvider(CONFIG.rpcUrls[0]);
        this.contract = new ethers.Contract(CONFIG.contractAddress, CONTRACT_ABI, this.provider);
    }

    async processChonk(routes) {
        for (const route of routes) {
            const candidates = [0.1, 1.0, 10.0, 100.0, 500.0].map(s => ethers.parseUnits(s.toString(), 6));
            
            for (const size of candidates) {
                // Rate-Limit Governor: Ensures we never exceed plan RPS
                await new Promise(r => setTimeout(r, CONFIG.REQUEST_DELAY));
                
                try {
                    const result = await this.contract.simulateArbitrageProfit(
                        route.buyRouter, route.sellRouter, size, route.pathToToken, route.pathToUSDC
                    );
                    
                    const netProfit = result.estimatedProfit - ethers.parseUnits("0.20", 6);
                    
                    // Continuous Display: Full output restored
                    const sign = netProfit >= 0n ? "+" : "-";
                    const formatted = ethers.formatUnits(netProfit < 0n ? -netProfit : netProfit, 6);
                    
                    console.log(`[${sign}] ${route.name.padEnd(45)} | Size: ${ethers.formatUnits(size, 6).padStart(8)} | Total: ${sign}${formatted} USDC`);
                    
                } catch (e) {
                    console.log(`[!] ${route.name.padEnd(45)} | Engine: Could not decode result data`);
                }
            }
        }
    }

    async scanAndExecute(blockNumber) {
        const allRoutes = this.generateRoutes();
        for (let i = 0; i < allRoutes.length; i += CONFIG.CHONK_SIZE) {
            await this.processChonk(allRoutes.slice(i, i + CONFIG.CHONK_SIZE));
        }
    }

    // ... [Rest of generateRoutes and start logic] ...
}

new RealTimeArbitrageBot().start();
