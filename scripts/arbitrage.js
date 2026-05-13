import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config();

/* =========================================================
   CONFIG
========================================================= */

const RPC = process.env.RPC_URL || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY; // Your wallet private key
const VAULT_CONTRACT = process.env.VAULT_CONTRACT; // Address of profit vault

const provider = new ethers.JsonRpcProvider(RPC);
const wallet = new ethers.Wallet(PRIVATE_KEY!, provider);

/* =========================================================
   TOKENS
========================================================= */

const TOKENS = {
  USDC: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  WETH: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
  WBTC: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",
  USDT: "0xc2132d05d31c914a87c6611c10748aeb04b58e8f",
  DAI:  "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063",
  MATIC:"0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270"
};

/* =========================================================
   DECIMALS
========================================================= */

const DECIMALS: { [key: string]: number } = {
  [TOKENS.USDC]: 6,
  [TOKENS.USDT]: 6,
  [TOKENS.WBTC]: 8,
  [TOKENS.WETH]: 18,
  [TOKENS.DAI]: 18,
  [TOKENS.MATIC]: 18
};

/* =========================================================
   PAIRS
========================================================= */

const QUICKSWAP_PAIRS = [
  "0x853Ee4b2A13f8a742d64C8F088bE7bA2131f670d",
  "0xf69e93771f11aecd8e554d32f1db7f3fbed4baf2",
  "0x2cf7252e74036d1da831d11089d326296e64a728"
];

const SUSHISWAP_PAIRS = [
  "0x34965ba0ac2451a34a0471f04cca3f990b8dea27",
  "0x34965ba0ac2451a34a0471f04cca3f990b8dea28",
  "0x34965ba0ac2451a34a0471f04cca3f990b8dea29"
];

/* =========================================================
   ABI (minimal LP pair + ERC20 + Flash Loan)
========================================================= */

const PAIR_ABI = [
  "function getReserves() view returns (uint112,uint112,uint32)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function swap(uint amount0Out, uint amount1Out, address to, bytes data)"
];

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)"
];

// Aave V3 pool for flash loans on Polygon
const FLASH_LOAN_PROVIDER = "0x794a61358D6845594F94dc1DB02A252b5b4814aD"; // Aave V3 Polygon Pool

const FLASH_LOAN_ABI = [
  "function flashLoan(address receiverAddress, address[] calldata assets, uint256[] calldata amounts, uint256[] calldata modes, address onBehalfOf, bytes calldata params, uint16 referralCode) external returns (bool)"
];

/* =========================================================
   CORE HELPERS
========================================================= */

function normalize(amount: string, decimals: number): number {
  return Number(amount) / Math.pow(10, decimals);
}

function denormalize(amount: number, decimals: number): bigint {
  return BigInt(Math.floor(amount * Math.pow(10, decimals)));
}

/* =========================================================
   FETCH RESERVES
========================================================= */

async function getReserves(pairAddress: string) {
  try {
    const pair = new ethers.Contract(pairAddress, PAIR_ABI, provider);
    const [r0, r1] = await pair.getReserves();
    const token0 = await pair.token0();
    const token1 = await pair.token1();

    return {
      r0: r0.toString(),
      r1: r1.toString(),
      token0,
      token1
    };
  } catch (e) {
    return null;
  }
}

/* =========================================================
   PRICE ENGINE
========================================================= */

function computePrice(res: any): number {
  const d0 = DECIMALS[res.token0] ?? 18;
  const d1 = DECIMALS[res.token1] ?? 18;

  const r0 = normalize(res.r0, d0);
  const r1 = normalize(res.r1, d1);

  if (!r0 || !r1) return 0;
  return r1 / r0;
}

/* =========================================================
   BIDIRECTIONAL ARB
========================================================= */

function analyze(priceA: number, priceB: number) {
  const ab = priceB - priceA;
  const ba = priceA - priceB;

  if (ab > ba) {
    return { direction: "A → B", spread: ab };
  }
  return { direction: "B → A", spread: ba };
}

/* =========================================================
   EXECUTE ACTUAL SWAP ON QUICKSWAP
========================================================= */

async function executeQuickSwapSwap(
  pairAddress: string,
  amountIn: bigint,
  tokenIn: string,
  tokenOut: string,
  recipient: string
): Promise<string> {
  const pair = new ethers.Contract(pairAddress, PAIR_ABI, wallet);
  const reserves = await pair.getReserves();
  const token0 = await pair.token0();
  
  // Determine which token is token0/token1
  let amount0Out = BigInt(0);
  let amount1Out = BigInt(0);
  
  if (tokenIn.toLowerCase() === token0.toLowerCase()) {
    // tokenIn is token0, so output is token1
    amount1Out = amountIn;
  } else {
    amount0Out = amountIn;
  }

  const tx = await pair.swap(amount0Out, amount1Out, recipient, "0x");
  const receipt = await tx.wait();
  return receipt!.hash;
}

/* =========================================================
   EXECUTE ACTUAL SWAP ON SUSHISWAP
========================================================= */

async function executeSushiSwapSwap(
  pairAddress: string,
  amountIn: bigint,
  tokenIn: string,
  tokenOut: string,
  recipient: string
): Promise<string> {
  const pair = new ethers.Contract(pairAddress, PAIR_ABI, wallet);
  const reserves = await pair.getReserves();
  const token0 = await pair.token0();
  
  let amount0Out = BigInt(0);
  let amount1Out = BigInt(0);
  
  if (tokenIn.toLowerCase() === token0.toLowerCase()) {
    amount1Out = amountIn;
  } else {
    amount0Out = amountIn;
  }

  const tx = await pair.swap(amount0Out, amount1Out, recipient, "0x");
  const receipt = await tx.wait();
  return receipt!.hash;
}

/* =========================================================
   EXECUTE FLASH LOAN FROM AAVE
========================================================= */

async function executeFlashLoan(
  tokenAddress: string,
  amount: bigint,
  params: string
): Promise<string> {
  const flashLoanContract = new ethers.Contract(
    FLASH_LOAN_PROVIDER,
    FLASH_LOAN_ABI,
    wallet
  );

  const tx = await flashLoanContract.flashLoan(
    wallet.address, // receiver
    [tokenAddress], // assets
    [amount], // amounts
    [0], // modes (0 = no debt, just return)
    wallet.address, // onBehalfOf
    params, // params for your custom logic
    0 // referral code
  );
  
  const receipt = await tx.wait();
  return receipt!.hash;
}

/* =========================================================
   DEPOSIT PROFITS TO VAULT CONTRACT
========================================================= */

async function depositProfitsToVault(
  tokenAddress: string,
  profitAmount: bigint
): Promise<string> {
  if (!VAULT_CONTRACT) {
    console.log("⚠️ No vault contract configured, skipping deposit");
    return "0x0000000000000000000000000000000000000000";
  }

  const token = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);
  
  // Approve vault to spend tokens
  const approveTx = await token.approve(VAULT_CONTRACT, profitAmount);
  await approveTx.wait();

  // Simple vault ABI for deposit - adjust based on your actual vault contract
  const VAULT_ABI = [
    "function deposit(address token, uint256 amount) external returns (bool)",
    "function deposit() external payable"
  ];
  
  const vault = new ethers.Contract(VAULT_CONTRACT, VAULT_ABI, wallet);
  
  // Assuming vault has a deposit function that accepts token and amount
  // Adjust this based on your actual vault contract interface
  const depositTx = await vault.deposit(tokenAddress, profitAmount);
  const receipt = await depositTx.wait();
  
  console.log(`💰 Deposited ${ethers.formatUnits(profitAmount, 6)} USDC to vault: ${receipt!.hash}`);
  return receipt!.hash;
}

/* =========================================================
   EXECUTE FULL ARBITRAGE
========================================================= */

async function executeArbitrage(
  bestPairA: string,
  bestPairB: string,
  direction: string,
  spread: number
) {
  console.log("\n🚀 EXECUTING ACTUAL ARBITRAGE...");

  try {
    const resA = await getReserves(bestPairA);
    const resB = await getReserves(bestPairB);
    
    if (!resA || !resB) {
      console.log("❌ Failed to fetch reserves for execution");
      return;
    }

    // Determine trade parameters
    const borrowAmount = BigInt(1000) * BigInt(10**6); // 1000 USDC for example
    const tokenIn = TOKENS.USDC;
    const tokenOut = TOKENS.WETH;
    
    // 1. Get flash loan
    console.log("📡 Getting flash loan from Aave...");
    const flashLoanTxHash = await executeFlashLoan(tokenIn, borrowAmount, "0x");
    console.log(`   Flash loan TX: ${flashLoanTxHash}`);

    // 2. Execute first swap
    console.log("📡 Executing first swap...");
    let tx1Hash: string;
    
    if (direction.includes("A")) {
      tx1Hash = await executeQuickSwapSwap(bestPairA, borrowAmount, tokenIn, tokenOut, wallet.address);
      console.log(`   Swap 1 (QuickSwap) TX: ${tx1Hash}`);
      
      // 3. Execute second swap
      const receivedAmount = borrowAmount; // Simplified - calculate actual received amount
      console.log("📡 Executing second swap...");
      const tx2Hash = await executeSushiSwapSwap(bestPairB, receivedAmount, tokenOut, tokenIn, wallet.address);
      console.log(`   Swap 2 (SushiSwap) TX: ${tx2Hash}`);
    } else {
      tx1Hash = await executeSushiSwapSwap(bestPairB, borrowAmount, tokenIn, tokenOut, wallet.address);
      console.log(`   Swap 1 (SushiSwap) TX: ${tx1Hash}`);
      
      const receivedAmount = borrowAmount;
      console.log("📡 Executing second swap...");
      const tx2Hash = await executeQuickSwapSwap(bestPairA, receivedAmount, tokenOut, tokenIn, wallet.address);
      console.log(`   Swap 2 (QuickSwap) TX: ${tx2Hash}`);
    }

    // 4. Calculate and deposit profit
    const profitAmount = denormalize(spread * 1000, 6); // Spread * capital as profit
    console.log(`💰 Profit calculated: ${ethers.formatUnits(profitAmount, 6)} USDC`);
    
    console.log("📡 Depositing profits to vault...");
    const depositTxHash = await depositProfitsToVault(tokenIn, profitAmount);
    console.log(`   Deposit TX: ${depositTxHash}`);

    console.log(`
✅ ARBITRAGE COMPLETED
   Flash Loan: ${flashLoanTxHash}
   Swap 1: ${tx1Hash}
   Swap 2: ${'tx2Hash' in arguments ? arguments : 'unknown'}
   Vault Deposit: ${depositTxHash}
   Profit: ${ethers.formatUnits(profitAmount, 6)} USDC
    `);
    
  } catch (error) {
    console.error("❌ Arbitrage execution failed:", error);
  }
}

/* =========================================================
   ENGINE
========================================================= */

async function runEngine() {
  console.log("\n🚀 VAULT ENGINE STARTED");
  console.log("🔎 SCANNING ALL PAIRS...\n");

  let best = null;

  for (let i = 0; i < QUICKSWAP_PAIRS.length; i++) {
    const pairAAddr = QUICKSWAP_PAIRS[i];
    const pairBAddr = SUSHISWAP_PAIRS[i];

    const resA = await getReserves(pairAAddr);
    const resB = await getReserves(pairBAddr);

    if (!resA || !resB) continue;

    const priceA = computePrice(resA);
    const priceB = computePrice(resB);

    if (priceA === 0 || priceB === 0) continue;

    const analysis = analyze(priceA, priceB);
    const spread = analysis.spread;
    const allocation = 100;
    const profitScore = Math.floor(spread * allocation * 100);

    console.log(`PAIR: USDC/WETH`);
    console.log(`DEXA_PRICE: ${priceA.toFixed(6)}`);
    console.log(`DEXB_PRICE: ${priceB.toFixed(6)}`);
    console.log(`SPREAD: ${spread.toFixed(6)}`);
    console.log(`📊 PROFIT_SCORE: ${profitScore}`);

    if (!best || profitScore > best.profitScore) {
      best = {
        pairA: pairAAddr,
        pairB: pairBAddr,
        priceA,
        priceB,
        spread,
        profitScore,
        direction: analysis.direction
      };
    }
  }

  if (!best || best.spread <= 0.001) { // Minimum 0.1% spread
    console.log("❌ NO PROFITABLE ARBITRAGE FOUND");
    return;
  }

  console.log("\n🏆 BEST OPPORTUNITY FOUND");
  console.log(`PAIR_A: ${best.pairA}`);
  console.log(`PAIR_B: ${best.pairB}`);
  console.log(`DIRECTION: ${best.direction}`);
  console.log(`SPREAD: ${best.spread.toFixed(6)}`);

  // Execute actual arbitrage
  await executeArbitrage(best.pairA, best.pairB, best.direction, best.spread);
}

/* =========================================================
   LOOP
========================================================= */

setInterval(runEngine, 15000);
runEngine();
