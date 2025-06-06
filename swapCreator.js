const {
    Connection,
    PublicKey,
    Transaction,
    sendAndConfirmTransaction,
    ComputeBudgetProgram
} = require('@solana/web3.js');
const {
    getAssociatedTokenAddress,
    createAssociatedTokenAccountInstruction,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
} = require('@solana/spl-token');
const {
    AmmV4,
    MAINNET_PROGRAM_ID,
    makeSwapInstruction
} = require('@raydium-io/raydium-sdk-v2');
const BN = require('bn.js');
require('dotenv').config();

class SwapCreator {
    constructor() {
        this.connection = new Connection(
            process.env.SOLANA_RPC_URL || process.env.SOLANA_WS_URL,
            'confirmed'
        );
    }

    /**
     * Main swap function - creates and executes swap transaction
     * @param {Object} params
     * @param {Object} params.lpData - Full LP data from MongoDB (tokenData)
     * @param {string|BN} params.amountSpecified - Amount to swap (in lamports)
     * @param {boolean} params.swapBaseIn - true for base->quote, false for quote->base
     * @param {Keypair} params.owner - Wallet keypair
     */
    async swapTokens({ lpData, amountSpecified, swapBaseIn, owner }) {
        try {
            console.log(`[SwapCreator] Starting swap - Base->Quote: ${swapBaseIn}, Amount: ${amountSpecified}`);

            // Convert amount to BN if it's a string
            const amount = typeof amountSpecified === 'string' ? new BN(amountSpecified) : amountSpecified;

            // Get pool info from stored lpData (no re-derivation needed)
            const poolKeys = this.getPoolKeysFromLpData(lpData);

            // Create swap instruction
            const swapInstruction = await this.createSwapInstruction({
                poolKeys,
                amount,
                swapBaseIn,
                owner: owner.publicKey,
                lpData
            });

            // Create transaction with compute budget and priority fee
            const transaction = new Transaction();

            // Add compute budget instructions
            const priorityFeeMultiplier = Number(process.env.PRIORITY_FEE_MULTIPLIER) || 1.5;
            const computeUnitPrice = Math.floor(50000 * priorityFeeMultiplier); // Base fee * multiplier

            transaction.add(
                ComputeBudgetProgram.setComputeUnitLimit({ units: 300000 }),
                ComputeBudgetProgram.setComputeUnitPrice({ microLamports: computeUnitPrice })
            );

            // Add token account creation instructions if needed
            const tokenAccountInstructions = await this.createTokenAccountInstructions(
                owner.publicKey,
                lpData,
                swapBaseIn
            );
            transaction.add(...tokenAccountInstructions);

            // Add swap instruction
            transaction.add(swapInstruction);

            // Send and confirm transaction
            const signature = await sendAndConfirmTransaction(
                this.connection,
                transaction,
                [owner],
                {
                    commitment: 'confirmed',
                    maxRetries: 3
                }
            );

            console.log(`[SwapCreator] Swap successful! Signature: ${signature}`);
            return signature;

        } catch (error) {
            console.error('[SwapCreator] Swap failed:', error);
            throw error;
        }
    }

    /**
     * Get pool keys from stored lpData - uses pre-computed addresses, no re-derivation
     */
    getPoolKeysFromLpData(lpData) {
        try {
            console.log('[SwapCreator] Using stored addresses from lpData:');
            console.log('  ammId:', lpData.ammId);
            console.log('  ammAuthority:', lpData.ammAuthority);
            console.log('  ammOpenOrders:', lpData.ammOpenOrders);
            console.log('  targetOrders:', lpData.targetOrders);
            console.log('  baseVault:', lpData.baseVault);
            console.log('  quoteVault:', lpData.quoteVault);
            console.log('  marketId:', lpData.marketId);

            return {
                id: new PublicKey(lpData.ammId),
                baseMint: new PublicKey(lpData.baseMint),
                quoteMint: new PublicKey(lpData.quoteMint),
                baseVault: new PublicKey(lpData.baseVault),
                quoteVault: new PublicKey(lpData.quoteVault),
                authority: new PublicKey(lpData.ammAuthority),
                openOrders: new PublicKey(lpData.ammOpenOrders),
                targetOrders: new PublicKey(lpData.targetOrders),
                marketId: new PublicKey(lpData.marketId),
                programId: new PublicKey(lpData.programId),
                marketProgramId: new PublicKey(lpData.marketProgramId),
                // Serum market accounts (stored in lpData)
                marketBids: new PublicKey(lpData.marketBids),
                marketAsks: new PublicKey(lpData.marketAsks),
                marketEventQueue: new PublicKey(lpData.marketEventQueue),
                marketBaseVault: new PublicKey(lpData.marketBaseVault),
                marketQuoteVault: new PublicKey(lpData.marketQuoteVault),
                marketAuthority: new PublicKey(lpData.marketAuthority),
                vaultOwner: new PublicKey(lpData.vaultOwner),
                // User accounts (pre-computed and stored)
                userBaseTokenAccount: new PublicKey(lpData.userBaseTokenAccount),
                userQuoteTokenAccount: new PublicKey(lpData.userQuoteTokenAccount)
            };
        } catch (error) {
            console.error('[SwapCreator] Failed to get pool keys from lpData:', error);
            throw error;
        }
    }

    /**
     * Create swap instruction using Raydium SDK v2
     */
    async createSwapInstruction({ poolKeys, amount, swapBaseIn, owner, lpData }) {
        try {
            // Use pre-computed user token accounts from lpData
            const userBaseTokenAccount = poolKeys.userBaseTokenAccount;
            const userQuoteTokenAccount = poolKeys.userQuoteTokenAccount;

            // Determine input/output accounts based on swap direction
            const [inputTokenAccount, outputTokenAccount] = swapBaseIn
                ? [userBaseTokenAccount, userQuoteTokenAccount]
                : [userQuoteTokenAccount, userBaseTokenAccount];

            // Create swap instruction using Raydium SDK v2 makeSwapInstruction
            const swapInstruction = makeSwapInstruction({
                poolKeys: {
                    id: poolKeys.id,
                    baseMint: poolKeys.baseMint,
                    quoteMint: poolKeys.quoteMint,
                    baseVault: poolKeys.baseVault,
                    quoteVault: poolKeys.quoteVault,
                    authority: poolKeys.authority,
                    openOrders: poolKeys.openOrders,
                    targetOrders: poolKeys.targetOrders,
                    marketId: poolKeys.marketId,
                    programId: poolKeys.programId,
                    marketProgramId: poolKeys.marketProgramId,
                    // Include Serum market accounts
                    marketBids: poolKeys.marketBids,
                    marketAsks: poolKeys.marketAsks,
                    marketEventQueue: poolKeys.marketEventQueue,
                    marketBaseVault: poolKeys.marketBaseVault,
                    marketQuoteVault: poolKeys.marketQuoteVault,
                    marketAuthority: poolKeys.marketAuthority,
                    vaultOwner: poolKeys.vaultOwner,
                },
                userKeys: {
                    tokenAccountIn: inputTokenAccount,
                    tokenAccountOut: outputTokenAccount,
                    owner: owner,
                },
                amountIn: amount,
                amountOut: new BN(0), // Minimum amount out (can be 0 for market orders)
                fixedSide: 'in' // We're specifying input amount
            });

            return swapInstruction;

        } catch (error) {
            console.error('[SwapCreator] Failed to create swap instruction:', error);
            throw error;
        }
    }

    /**
     * Create associated token account instructions if they don't exist
     * Uses pre-computed addresses from lpData
     */
    async createTokenAccountInstructions(owner, lpData, swapBaseIn) {
        const instructions = [];

        try {
            const baseMint = new PublicKey(lpData.baseMint);
            const quoteMint = new PublicKey(lpData.quoteMint);

            // Use pre-computed associated token addresses from lpData
            const userBaseTokenAccount = new PublicKey(lpData.userBaseTokenAccount);
            const userQuoteTokenAccount = new PublicKey(lpData.userQuoteTokenAccount);

            // Check if accounts exist
            const [baseAccountInfo, quoteAccountInfo] = await Promise.all([
                this.connection.getAccountInfo(userBaseTokenAccount),
                this.connection.getAccountInfo(userQuoteTokenAccount)
            ]);

            // Create base token account if it doesn't exist
            if (!baseAccountInfo) {
                instructions.push(
                    createAssociatedTokenAccountInstruction(
                        owner, // payer
                        userBaseTokenAccount, // associated token account
                        owner, // owner
                        baseMint, // mint
                        TOKEN_PROGRAM_ID,
                        ASSOCIATED_TOKEN_PROGRAM_ID
                    )
                );
                console.log('[SwapCreator] Creating base token account');
            }

            // Create quote token account if it doesn't exist
            if (!quoteAccountInfo) {
                instructions.push(
                    createAssociatedTokenAccountInstruction(
                        owner, // payer
                        userQuoteTokenAccount, // associated token account
                        owner, // owner
                        quoteMint, // mint
                        TOKEN_PROGRAM_ID,
                        ASSOCIATED_TOKEN_PROGRAM_ID
                    )
                );
                console.log('[SwapCreator] Creating quote token account');
            }

        } catch (error) {
            console.error('[SwapCreator] Error creating token account instructions:', error);
            // Don't throw here, let the swap attempt anyway
        }

        return instructions;
    }

    /**
     * Helper function to get token balance
     */
    async getTokenBalance(owner, mintAddress) {
        try {
            const tokenAccount = await getAssociatedTokenAddress(
                new PublicKey(mintAddress),
                owner
            );

            const balance = await this.connection.getTokenAccountBalance(tokenAccount);
            return balance.value.amount;
        } catch (error) {
            console.error('[SwapCreator] Error getting token balance:', error);
            return '0';
        }
    }

    /**
     * Helper function to estimate swap output (optional, for logging)
     */
    async estimateSwapOutput({ poolKeys, amountIn, swapBaseIn }) {
        try {
            // This would require implementing the AMM math
            // For now, we'll skip this and rely on the actual swap
            console.log('[SwapCreator] Swap estimation not implemented yet');
            return null;
        } catch (error) {
            console.error('[SwapCreator] Error estimating swap:', error);
            return null;
        }
    }
}

// Export singleton instance
module.exports = new SwapCreator();

// Also export the class for testing
module.exports.SwapCreator = SwapCreator;
