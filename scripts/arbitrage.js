import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config({ override: false });

/* ================= ENV ================= */

const RPC =
  process.env.RPC_POLYGON ||
  process.env.POLYGON_RPC ||
  process.env.RPC_URL;

const PK =
  process.env.WALLET_PRIVATE_KEY ||
  process.env.PRIVATE_KEY;

const VAULT_CONTRACT =
  process.env.VAULT_CONTRACT_ADDRESS ||
  "0x6dED2f1A44Ac58201510ddd56677ecb864Af5467";

const USDC =
  process.env.USDC_ADDRESS ||
  "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";


/* ================= SETTINGS ================= */

const WORKERS = 16;
const TARGET_BATCH = 240;
const MIN_PROFIT = 0.000001;
const DEADLINE = 300;


/* ================= PROVIDER ================= */

const provider = new ethers.JsonRpcProvider(RPC);
const wallet = new ethers.Wallet(PK, provider);


/* ================= ABI ================= */

const abi = [
  "function executeFlashBatchArbitrage(address[] buyRouters,address[] sellRouters,uint256[] amounts,address[][] pathsToToken,address[][] pathsToUSDC,uint256 deadline) external",
  "function usdc() view returns(address)",
];

const vault = new ethers.Contract(
  VAULT_CONTRACT,
  abi,
  wallet
);


/* ================= ERC20 ================= */

const erc20Abi = [
  "function balanceOf(address) view returns(uint256)"
];

const usdc = new ethers.Contract(
  USDC,
  erc20Abi,
  provider
);


/* ================= SAMPLE ROUTES ================= */
/* replace with real scan later */

const ROUTERS = [
  "0xa5e0829caecd60d7f8a2a52fdf2a4c1a4a1fdd1b",
  "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
];

const TOKENS = [
  "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
  "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063",
];


/* ================= BUFFER ================= */

let buffer = [];


/* ================= BALANCE LOG ================= */

async function logBalances() {

  const matic = await provider.getBalance(wallet.address);

  const vaultBal = await usdc.balanceOf(
    VAULT_CONTRACT
  );

  console.log(
    `MATIC: ${ethers.formatEther(matic)}`
  );

  console.log(
    `Vault USDC: ${ethers.formatUnits(vaultBal,6)}`
  );
}


/* ================= WORKER ================= */

async function worker(id) {

  while (true) {

    const buy =
      ROUTERS[
        Math.floor(Math.random()*ROUTERS.length)
      ];

    const sell =
      ROUTERS[
        Math.floor(Math.random()*ROUTERS.length)
      ];

    if (buy === sell) continue;

    const token =
      TOKENS[
        Math.floor(Math.random()*TOKENS.length)
      ];

    const amount =
      Math.floor(
        (0.05 + Math.random()*0.2) * 1e6
      );

    const profit =
      Math.random()*0.002;

    if (profit < MIN_PROFIT) continue;

    buffer.push({
      buy,
      sell,
      amount,
      path1: [USDC, token],
      path2: [token, USDC]
    });

  }

}


/* ================= START WORKERS ================= */

for (let i=0;i<WORKERS;i++) {

  worker(i);

}


/* ================= BUILD BATCH ================= */

function buildBatch() {

  const trades =
    buffer.splice(0, TARGET_BATCH);

  const buyRouters = [];
  const sellRouters = [];
  const amounts = [];
  const paths1 = [];
  const paths2 = [];

  for (const t of trades) {

    buyRouters.push(t.buy);
    sellRouters.push(t.sell);

    amounts.push(
      BigInt(t.amount)
    );

    paths1.push(t.path1);
    paths2.push(t.path2);

  }

  return {
    trades,
    buyRouters,
    sellRouters,
    amounts,
    paths1,
    paths2
  };

}


/* ================= SIMULATION ================= */

async function simulate(batch) {

  try {

    await vault.executeFlashBatchArbitrage.staticCall(
      batch.buyRouters,
      batch.sellRouters,
      batch.amounts,
      batch.paths1,
      batch.paths2,
      Math.floor(Date.now()/1000)+DEADLINE
    );

    return true;

  } catch {

    return false;

  }

}


/* ================= EXECUTE ================= */

async function execute(batch) {

  console.log(
    `Collected trades: ${buffer.length}`
  );

  console.log(
    `Compressed: ${batch.amounts.length}`
  );

  console.log("Executing batch...\n");

  const ok = await simulate(batch);

  if (!ok) {

    console.log(
      "Preflight failed — skipping batch"
    );

    return;

  }

  const tx =
    await vault.executeFlashBatchArbitrage(

      batch.buyRouters,
      batch.sellRouters,
      batch.amounts,
      batch.paths1,
      batch.paths2,
      Math.floor(Date.now()/1000)+DEADLINE,

      { gasLimit: 8_000_000 }

    );

  console.log(
    "Transaction sent:",
    tx.hash
  );

  const receipt =
    await tx.wait();

  console.log(
    "Transaction confirmed"
  );

  console.log(
    "Gas used:",
    receipt.gasUsed.toString()
  );

  await logBalances();

}


/* ================= LOOP ================= */

async function loop() {

  while (true) {

    if (buffer.length >= TARGET_BATCH) {

      const batch =
        buildBatch();

      await execute(batch);

    }

    await new Promise(
      r=>setTimeout(r,500)
    );

  }

}

loop();
