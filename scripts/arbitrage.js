/**
 * Trading Bot Configuration File
 * Target Platform: Node.js (ES6 / CommonJS compatible)
 */

const tradingConfig = {
  // General Bot Environment Settings
  environment: "production", // "development" or "production"
  chainId: 137,             // Polygon PoS Mainnet (Example)

  // Execution Thresholds (As requested)
  execution: {
    // Sequential trade tiers to test for maximum capital efficiency
    tradeAmounts: [0.01, 0.10, 1, 10, 100, 1000],
    
    // Minimum net profit expected in base currency after gas fees
    minProfit: 0.00001,
    
    // Maximum slippage tolerance allowed per trade (0.5%)
    maxSlippageBps: 50,
    
    // Deadline for transaction validity in seconds
    txDeadlineSeconds: 60
  },

  // Token & Contract Infrastructure Mapping
  tokens: {
    baseCurrency: {
      symbol: "USDC",
      address: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359",
      decimals: 6
    },
    targetCurrency: {
      symbol: "WETH",
      address: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",
      decimals: 18
    }
  },

  // Decentralized Exchange (DEX) Target Routers
  protocols: {
    quickswapV2Router: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
    sushiswapRouter:   "0x1b02dA8Cb0d097e645729F65773B67166258f70C"
  },

  // Gas Optimization Settings
  gasStrategy: {
    mode: "aggressive", // Options: "safeLow", "standard", "aggressive"
    maxGasPriceGwei: 500,
    gasLimitBufferMultiplier: 1.15 // Add 15% safety layer to estimated gas
  },

  // Connection Nodes
  rpc: {
    httpEndpoints: [
      "https://polygon-rpc.com",
      "https://rpc.ankr.com/polygon"
    ],
    wsEndpoints: [
      "wss://polygon-mainnet.g.alchemy.com/v2/YOUR_API_KEY"
    ]
  }
};

module.exports = tradingConfig;
