
import dotenv from "dotenv";
import { ethers } from "ethers";

/* ================= ENV ================= */

dotenv.config({ override: false });

const RPC_POLYGON =
  (process.env.RPC_POLYGON ||
    process.env.POLYGON_RPC ||
    process.env.RPC_URL ||
    "").trim();

const WALLET_PRIVATE_KEY =
  (process.env.WALLET_PRIVATE_KEY ||
    process.env.PRIVATE_KEY ||
    "").trim();

if (!RPC_POLYGON) throw new Error("RPC_POLYGON missing");
if (!WALLET_PRIVATE_KEY) throw new Error("PRIVATE_KEY missing");

/* ================= COLORS ================= */

const GREEN = "\x1b[92m";
const RESET = "\x1b[0m";
const CYAN = "\x1b[96m";
const YELLOW = "\x1b[93m";
const RED = "\x1b[91m";

/* ================= CONSTANTS ================= */

const MIN_TRADE_USDC = .20;
const MIN_EXPECTED_PROFIT = 0.000001;

const SCAN_INTERVAL_MS = 10_000;
const DEADLINE_SECONDS = 60;

/* ================= PROVIDER ================= */

const provider = new ethers.JsonRpcProvider(RPC_POLYGON);
const wallet = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);

/* ================= CONTRACT ================= */

const VAULT_ADDRESS = "0x621F7ccEb67136f7922E36aF56137e7A1dbA22f1";

/* ================= TOKENS ================= */

const USDCe_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

const erc20Abi = [
  "function balanceOf(address) view returns (uint256)"
];

const usdcContract = new ethers.Contract(
  USDCe_ADDRESS,
  erc20Abi,
  provider
);

/* ================= BALANCE DISPLAY ================= */

async function displayBalances() {
  try {
    const vaultUSDC = await usdcContract.balanceOf(VAULT_ADDRESS);
    const walletMatic = await provider.getBalance(wallet.address);

    console.log(
      `${YELLOW}---------------- BALANCES ----------------${RESET}`
    );

    console.log(
      `Vault USDC.e Balance: ${GREEN}${ethers.formatUnits(vaultUSDC, 6)} USDC${RESET}`
    );

    console.log(
      `Wallet MATIC Balance: ${GREEN}${ethers.formatEther(walletMatic)} MATIC${RESET}`
    );

    console.log(
      `${YELLOW}------------------------------------------${RESET}\n`
    );

  } catch (err) {
    console.log(`${RED}Balance fetch failed:${RESET}`, err.message);
  }
}
