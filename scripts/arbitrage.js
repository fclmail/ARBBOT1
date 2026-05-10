import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config();

/* ================= ENV ================= */

const PRIVATE_KEY =
  process.env.WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY;

if (!PRIVATE_KEY) throw new Error("Missing PK");

/* ================= CONFIG ================= */

const RPC = "https://polygon-bor-rpc.publicnode.com";

const provider = new ethers.JsonRpcProvider(RPC);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

/* ================= CONTRACT ================= */

const CONTRACT_ADDRESS =
  "0x1923E396811f0586440e5bD69fa3b4Bf9db2DE61";

const abi = [
  "function triggerFlashArbitrage(address[3] route,uint256 amountIn,uint256 minProfit)"
];

const vault = new ethers.Contract(CONTRACT_ADDRESS, abi, wallet);

/* ================= TOKENS ================= */

const TOKENS = {
  WETH: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
  WMATIC: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  DAI: "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063",
  USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
  WBTC: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6"
};

const USDC = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

/* ================= HELPERS ================= */

const fmt = (x) => Number(ethers.formatUnits(x, 6)).toFixed(6);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ================= ROUTE ================= */

function makeRoute(token) {
  return [
    USDC,
    token,
    USDC
  ];
}

/* ================= VAULT BALANCE ================= */

async function getVaultBalance() {
  const erc20 = new ethers.Contract(
    USDC,
    ["function balanceOf(address) view returns(uint256)"],
    provider
  );

  return await erc20.balanceOf(CONTRACT_ADDRESS);
}

/* ================= SIMULATED EDGE ================= */

function simulateProfit() {
  return BigInt(Math.floor(Math.random() * 5000));
}

/* ================= MICRO SCAN ================= */

async function scanToken(name, token) {

  const vaultBal = await getVaultBalance();

  const profit = simulateProfit();

  const efficiency = (profit * 1_000_000n) / (vaultBal + 1n);

  /* ================= CONTINUOUS SCALING ================= */

  let scale = 5n;

  if (efficiency > 3000000n) scale = 30n;
  else if (efficiency > 1500000n) scale = 20n;
  else if (efficiency > 800000n) scale = 10n;

  const size = (vaultBal * scale) / 100n;

  /* ================= LOG ================= */

  console.log(`\n🔎 SCANNING ${name}`);
  console.log(`💰 Vault: ${fmt(vaultBal)} USDC`);
  console.log(`📊 Profit: ${fmt(profit)}`);
  console.log(`⚡ Efficiency: ${efficiency}`);
  console.log(`📐 SCALE: ${Number(scale) / 100}x`);
  console.log(`🚀 SIZE: ${fmt(size)} USDC`);

  return {
    token,
    profit,
    size,
    route: makeRoute(token)
  };
}

/* ================= EXECUTION ================= */

async function execute(signal) {

  console.log(`\n🔥 EXECUTING TRADE`);

  const before = await getVaultBalance();

  const tx = await vault.triggerFlashArbitrage(
    signal.route,   // ✔ FIXED: tuple array (NOT object)
    signal.size,
    1n
  );

  console.log(`TX: ${tx.hash}`);

  await tx.wait();

  const after = await getVaultBalance();

  const profit = after - before;

  console.log(`\n💰 BEFORE: ${fmt(before)}`);
  console.log(`💰 AFTER : ${fmt(after)}`);
  console.log(`📈 PROFIT: ${fmt(profit)}`);
}

/* ================= MAIN LOOP ================= */

async function main() {

  console.log("🚀 MICRO→MACRO CONTINUOUS ENGINE STARTED");

  while (true) {

    const results = await Promise.all(
      Object.entries(TOKENS).map(([n, t]) => scanToken(n, t))
    );

    const best = results.reduce((a, b) =>
      b.profit > a.profit ? b : a
    );

    console.log(`\n🏆 BEST SIGNAL`);
    console.log(`TOKEN: ${best.token}`);
    console.log(`PROFIT: ${fmt(best.profit)}`);
    console.log(`SIZE: ${fmt(best.size)}`);

    if (best.profit > 2000n) {
      await execute(best);
    }

    await sleep(2000);
  }
}

main();
