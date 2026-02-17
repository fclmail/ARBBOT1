// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

/* ===================== ORIGINAL INTERFACES ===================== */

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address recipient, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
}

interface IUniswapV2Router {
    function swapExactTokensForTokens(
        uint amountIn,
        uint amountOutMin,
        address[] calldata path,
        address to,
        uint deadline
    ) external returns (uint[] memory amounts);
}

/* ===================== AAVE V3 INTERFACES ===================== */

interface IPool {
    function flashLoanSimple(
        address receiver,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 referralCode
    ) external;
}

interface IPoolAddressesProvider {
    function getPool() external view returns (address);
}

abstract contract FlashLoanSimpleReceiverBase {
    IPool public immutable POOL;

    constructor(IPoolAddressesProvider provider) {
        POOL = IPool(provider.getPool());
    }

    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external virtual returns (bool);
}

/* ===================== MAIN CONTRACT ===================== */

contract VaultArbitrageEnforcer is FlashLoanSimpleReceiverBase {
    address public owner;
    address public vault;
    IERC20 public usdc;

    uint256 public minimumProfitUSDC;

    event ArbitrageExecuted(
        address indexed buyRouter,
        address indexed sellRouter,
        address indexed token,
        uint256 amountInUSDC,
        uint256 beforeBal,
        uint256 afterBal,
        uint256 profitUSDC
    );

    event MinProfitUpdated(uint256 newMin);

    constructor(
        address _usdc,
        address _vault,
        uint256 _minimumProfitUSDC,
        IPoolAddressesProvider provider
    ) FlashLoanSimpleReceiverBase(provider) {
        owner = msg.sender;
        usdc = IERC20(_usdc);
        vault = _vault;
        minimumProfitUSDC = _minimumProfitUSDC;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    /* ================= INTERNAL ARBITRAGE ================= */

    function _performOnChainArbitrage(
        address buyRouter,
        address sellRouter,
        uint256 amountInUSDC,
        address[] memory pathToToken,
        address[] memory pathToUSDC,
        uint256 deadline
    ) internal returns (uint256) {

        uint256 beforeBal = usdc.balanceOf(address(this));

        if (usdc.allowance(address(this), buyRouter) < amountInUSDC) {
            usdc.approve(buyRouter, type(uint256).max);
        }

        IUniswapV2Router(buyRouter).swapExactTokensForTokens(
            amountInUSDC,
            0,
            pathToToken,
            address(this),
            deadline
        );

        IERC20 token = IERC20(pathToUSDC[0]);
        uint256 tokenBal = token.balanceOf(address(this));

        if (token.allowance(address(this), sellRouter) < tokenBal) {
            token.approve(sellRouter, type(uint256).max);
        }

        IUniswapV2Router(sellRouter).swapExactTokensForTokens(
            tokenBal,
            0,
            pathToUSDC,
            address(this),
            deadline
        );

        return usdc.balanceOf(address(this));
    }

    /* ================= NORMAL VAULT ARBITRAGE ================= */

    function executeArbitrage(
        address buyRouter,
        address sellRouter,
        uint256 amountInUSDC,
        address[] calldata pathToToken,
        address[] calldata pathToUSDC,
        uint256 deadline
    ) external {

        require(msg.sender == owner || msg.sender == vault, "Unauthorized");

        uint256 beforeBal = usdc.balanceOf(address(this));
        require(beforeBal >= amountInUSDC, "Insufficient vault balance");

        uint256 afterBal = _performOnChainArbitrage(
            buyRouter,
            sellRouter,
            amountInUSDC,
            pathToToken,
            pathToUSDC,
            deadline
        );

        require(
            afterBal >= beforeBal + minimumProfitUSDC,
            "Profit below minimum"
        );

        uint256 profit = afterBal - beforeBal;

        emit ArbitrageExecuted(
            buyRouter,
            sellRouter,
            pathToUSDC[0],
            amountInUSDC,
            beforeBal,
            afterBal,
            profit
        );
    }

    /* ================= FLASH LOAN ENTRY ================= */

    function executeFlashArbitrage(
        address buyRouter,
        address sellRouter,
        uint256 amountInUSDC,
        address[] calldata pathToToken,
        address[] calldata pathToUSDC,
        uint256 deadline
    ) external onlyOwner {

        bytes memory params = abi.encode(
            buyRouter,
            sellRouter,
            pathToToken,
            pathToUSDC,
            deadline
        );

        POOL.flashLoanSimple(
            address(this),
            address(usdc),
            amountInUSDC,
            params,
            0
        );
    }

    /* ================= FLASH CALLBACK ================= */

    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address,
        bytes calldata params
    ) external override returns (bool) {

        require(asset == address(usdc), "Invalid asset");

        (
            address buyRouter,
            address sellRouter,
            address[] memory pathToToken,
            address[] memory pathToUSDC,
            uint256 deadline
        ) = abi.decode(params, (
            address,
            address,
            address[],
            address[],
            uint256
        ));

        uint256 beforeBal = usdc.balanceOf(address(this));

        uint256 afterBal = _performOnChainArbitrage(
            buyRouter,
            sellRouter,
            amount,
            pathToToken,
            pathToUSDC,
            deadline
        );

        uint256 totalOwed = amount + premium;

        require(
            afterBal >= beforeBal + minimumProfitUSDC + premium,
            "Flash profit below minimum"
        );

        uint256 profit = afterBal - beforeBal - premium;

        usdc.approve(address(POOL), totalOwed);

        return true;
    }

    /* ================= WITHDRAW FUNCTION ================= */

    function withdraw(uint256 amount) external onlyOwner {
        usdc.transfer(owner, amount);
    }
}


