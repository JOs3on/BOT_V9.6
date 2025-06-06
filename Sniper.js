const { Connection, PublicKey, Keypair } = require('@solana/web3.js');
const swapCreator = require('./swapCreator'); // Import the singleton instance
const bs58 = require('bs58');
const { MongoClient } = require('mongodb');
require('dotenv').config();

class Sniper {
    constructor(cfg, fullLpData = null) {
        // ---------- 1.  minimal runtime state ----------
        Object.assign(this, cfg);          // tokenId, ammId, K, V, etc.
        this.buyAmount        = cfg.buyAmount;
        this.targetMultiplier = 1 + cfg.sellTargetPrice / 100;
        this.calculatedSell   = cfg.V * this.targetMultiplier;

        // Compute decimal scaling factor (NEW)
        this.decimalFactor = 10 ** (this.quoteDecimals - this.baseDecimals);

        // ---------- 2.  Infra ----------
        this.owner      = Keypair.fromSecretKey(bs58.default.decode(process.env.WALLET_PRIVATE_KEY));
        this.connection = new Connection(process.env.SOLANA_WS_URL || process.env.SOLANA_RPC_URL, 'confirmed');

        // ---------- 3.  Phase flags ----------
        this.fullLpData = fullLpData;      // cleared after buy
        this.vaultSubId = null;
        this.db         = null;
    }

    /* ------------ BUY ONCE ---------------- */
    async executeBuy() {
        if (!this.fullLpData) throw new Error('LP data missing for buy phase');
        console.log(`[BUY] Swapping ${this.buyAmount} quote tokens for base`);

        await swapCreator.swapTokens({ // Use the singleton instance
            lpData: this.fullLpData,
            amountSpecified: this.toLamports(this.buyAmount, this.quoteDecimals),
            swapBaseIn: false,
            owner: this.owner
        });

        // Free memory
        this.fullLpData = null;
    }

    /* ------------ LIVE PRICE WATCHER ---------------- */
    async subscribeToVault() {
        const quoteVault = new PublicKey(this.quoteVault);
        this.vaultSubId = this.connection.onAccountChange(
            quoteVault,
            async ({ lamports }) => {
                // Convert to human-readable units
                const quoteHuman = lamports / 10 ** this.quoteDecimals;

                // Calculate current price using normalized K (UPDATED)
                const priceNow = (quoteHuman * quoteHuman) / Number(this.K);

                console.log(`[PRICE] ${this.tokenId}: ${priceNow} SOL`);

                if (priceNow >= this.calculatedSell) {
                    await this.executeSell();
                    await this.unsubscribe();
                }
            },
            'confirmed'
        );
        console.log(`[SUB] Watching vault ${this.quoteVault}`);
    }

    async unsubscribe() {
        if (this.vaultSubId) {
            await this.connection.removeAccountChangeListener(this.vaultSubId);
            this.vaultSubId = null;
        }
    }

    /* ------------ SELL ---------------- */
    async executeSell() {
        // pull fresh LP doc (we cleared it after buy)
        const lpData = await this.fetchFromMongo();
        console.log(`[SELL] price target hit – exiting position`);

        await swapCreator.swapTokens({ // Use the singleton instance
            lpData,
            amountSpecified: await this.getTokenBalance(),
            swapBaseIn: true,
            owner: this.owner
        });
    }

    /* ------------ HELPERS ---------------- */
    async fetchFromMongo() {
        if (!this.db) {
            const cli = new MongoClient(process.env.MONGO_URI);
            await cli.connect();
            this.db = cli.db('bot');
        }
        return this.db.collection('raydium_lp_transactionsV3')
            .findOne({ _id: this.tokenId });
    }

    async getTokenBalance() {
        const res = await this.connection.getTokenAccountsByOwner(
            this.owner.publicKey,
            { mint: new PublicKey(this.baseMint) }
        );
        if (res.value.length === 0) return 0;
        const bal = await this.connection.getTokenAccountBalance(res.value[0].pubkey);
        return bal.value.amount;
    }

    toLamports(x, dec) { return Math.floor(x * 10 ** dec); }
}

module.exports = Sniper;
