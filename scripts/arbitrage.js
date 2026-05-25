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
    event VaultUpdated(address newVault);

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

    /* ================= SET VAULT ================= */

    function setVault(address _newVault) external onlyOwner {
        require(_newVault != address(0), "Zero address");
        vault = _newVault;
        emit VaultUpdated(_newVault);
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
        usdc.transfer(vault, profit);

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

    /* ================= SINGLE FLASH ================= */

    function executeFlashArbitrage(
        address buyRouter,
        address sellRouter,
        uint256 amountInUSDC,
        address[] calldata pathToToken,
        address[] calldata pathToUSDC,
        uint256 deadline
    ) external onlyOwner {

        bytes memory params = abi.encode(
            false,
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

    /* ================= BATCH FLASH ================= */

    function executeFlashBatchArbitrage(
        address[] calldata buyRouters,
        address[] calldata sellRouters,
        uint256[] calldata amountsInUSDC,
        address[][] calldata pathsToToken,
        address[][] calldata pathsToUSDC,
        uint256 deadline
    ) external onlyOwner {

        require(
            buyRouters.length == sellRouters.length &&
            buyRouters.length == amountsInUSDC.length &&
            buyRouters.length == pathsToToken.length &&
            buyRouters.length == pathsToUSDC.length,
            "Length mismatch"
        );

        uint256 totalAmount;

        for (uint256 i = 0; i < amountsInUSDC.length; i++) {
            totalAmount += amountsInUSDC[i];
        }

        bytes memory params = abi.encode(
            true,
            buyRouters,
            sellRouters,
            amountsInUSDC,
            pathsToToken,
            pathsToUSDC,
            deadline
        );

        POOL.flashLoanSimple(
            address(this),
            address(usdc),
            totalAmount,
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

        bool isBatch = abi.decode(params, (bool));

        uint256 beforeBal = usdc.balanceOf(address(this));

        if (!isBatch) {

            (
                ,
                address buyRouter,
                address sellRouter,
                address[] memory pathToToken,
                address[] memory pathToUSDC,
                uint256 deadline
            ) = abi.decode(params, (
                bool,
                address,
                address,
                address[],
                address[],
                uint256
            ));

            _performOnChainArbitrage(
                buyRouter,
                sellRouter,
                amount,
                pathToToken,
                pathToUSDC,
                deadline
            );

        } else {

            (
                ,
                address[] memory buyRouters,
                address[] memory sellRouters,
                uint256[] memory amountsInUSDC,
                address[][] memory pathsToToken,
                address[][] memory pathsToUSDC,
                uint256 deadline
            ) = abi.decode(params, (
                bool,
                address[],
                address[],
                uint256[],
                address[][],
                address[][],
                uint256
            ));

            uint256 batchBeforeBal = beforeBal;
            uint256 batchAfterBal = beforeBal;

            for (uint256 i = 0; i < buyRouters.length; i++) {

                (uint256 tradeAfterBal, uint256 tradeProfit) = _executeBatchTrade(
                    buyRouters[i],
                    sellRouters[i],
                    amountsInUSDC[i],
                    pathsToToken[i],
                    pathsToUSDC[i],
                    deadline
                );

                batchAfterBal = tradeAfterBal;

                emit ArbitrageExecuted(
                    buyRouters[i],
                    sellRouters[i],
                    pathsToUSDC[i][0],
                    amountsInUSDC[i],
                    tradeAfterBal - tradeProfit,
                    tradeAfterBal,
                    tradeProfit
                );
            }

            require(
                batchAfterBal >= batchBeforeBal + minimumProfitUSDC,
                "Flash profit below minimum (batch)"
            );

            uint256 aggregatedProfit = batchAfterBal - batchBeforeBal;

            if (aggregatedProfit > 0) {
                usdc.transfer(vault, aggregatedProfit);
            }
        }

        uint256 afterBal = usdc.balanceOf(address(this));

        if (!isBatch) {
            require(
                afterBal >= beforeBal + minimumProfitUSDC + premium,
                "Flash profit below minimum"
            );
        }

        /* ======== ADDED FIX FOR AAVE REPAYMENT ======== */

        uint256 amountOwed = amount + premium;

        if (usdc.allowance(address(this), address(POOL)) < amountOwed) {
            usdc.approve(address(POOL), type(uint256).max);
        }

        /* ============================================== */

        return true;
    }

    /* ================= INTERNAL HELPERS ================= */

    function _executeBatchTrade(
        address buyRouter,
        address sellRouter,
        uint256 amountInUSDC,
        address[] memory pathToToken,
        address[] memory pathToUSDC,
        uint256 deadline
    ) internal returns (uint256 tradeAfterBal, uint256 tradeProfit) {

        uint256 beforeBal = usdc.balanceOf(address(this));

        uint256 afterBal = _performOnChainArbitrage(
            buyRouter,
            sellRouter,
            amountInUSDC,
            pathToToken,
            pathToUSDC,
            deadline
        );

        tradeAfterBal = afterBal;
        tradeProfit = afterBal > beforeBal ? afterBal - beforeBal : 0;

        return (tradeAfterBal, tradeProfit);
    }

    /* ================= OWNER FUNCTIONS ================= */

    function withdraw(uint256 amount) external onlyOwner {
        usdc.transfer(owner, amount);
    }
}
