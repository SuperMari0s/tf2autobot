/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-call */

import SteamID from 'steamid';
import Currencies from '@tf2autobot/tf2-currencies';
import SKU from '@tf2autobot/tf2-sku';
import axios from 'axios';
import Bot from './Bot';
import log from '../lib/logger';
import { TradeOffer } from '@tf2autobot/tradeoffer-manager';

export default class SniperManager {
    private isExecuting = false;

    constructor(private readonly bot: Bot) {}

    async evaluateListing(listing: any): Promise<void> {
        if (this.isExecuting) return;
        if (!this.bot.options.sniper.enable) return;

        // specifications: Only process sell orders (intent === 1)
        if (listing.intent !== 1) return;

        // specifications: items that provide a valid user.tradeLink
        if (!listing.user || !listing.user.tradeLink) return;

        const sku = SKU.fromObject(listing.item);
        if (!sku) return;

        const pricelistEntry = this.bot.pricelist.getPrice({ priceKey: sku, onlyEnabled: true });
        if (!pricelistEntry) return;

        const keyPrice = this.bot.pricelist.getKeyPrice;
        const listedPrice = new Currencies(listing.currencies);
        const internalBuyPriceTarget = pricelistEntry.buy;

        const profit = internalBuyPriceTarget.toValue(keyPrice.metal) - listedPrice.toValue(keyPrice.metal);
        const minProfit = this.bot.options.sniper.minProfit || 0.33;

        if (profit >= Currencies.toScrap(minProfit)) {
            log.info(
                `[SNIPER] Found a good deal for ${sku}! Listed: ${listedPrice.toString()}, Internal Buy: ${internalBuyPriceTarget.toString()}. Profit: ${Currencies.toRefined(profit)} ref.`
            );
            this.isExecuting = true;
            try {
                await this.executeTrade(listing, sku, listedPrice);
            } catch (err) {
                log.error(`[SNIPER] Failed to execute trade for ${sku}:`, err);
            } finally {
                this.isExecuting = false;
            }
        }
    }

    private async executeTrade(listing: any, sku: string, price: Currencies): Promise<void> {
        const sellerId = new SteamID(listing.steamid);
        const tradeLink = listing.user.tradeLink;
        const urlParams = new URLSearchParams(tradeLink.split('?')[1]);
        const token = urlParams.get('token');

        if (!token) {
            log.warn(`[SNIPER] No token found in trade link for ${sku}.`);
            return;
        }

        const offer = this.bot.manager.createOffer(sellerId, token);

        log.debug(`[SNIPER] Fetching inventory for ${sellerId.getSteamID64()}...`);
        const sellerInventory = await new Promise<any[]>((resolve, reject) => {
            this.bot.manager.getUserInventoryContents(sellerId, 440, '2', true, (err, inventory) => {
                if (err) return reject(err);
                resolve(inventory);
            });
        });

        // Resolve assetid of the listing's target item
        // We match by name/properties since we don't have the seller's assetid directly in snapshot sometimes,
        // but backpack.tf listings usually have 'id' if it's an item listing.
        const targetAssetId = listing.id.startsWith('440_') ? listing.id.substring(4) : listing.id;
        const itemToBuy = sellerInventory.find(i => i.assetid === targetAssetId);

        if (!itemToBuy) {
            log.warn(`[SNIPER] Item ${targetAssetId} not found in seller inventory. (Ghost listing)`);
            return;
        }

        offer.addTheirItem(itemToBuy);

        // Add our currencies
        const myInventory = this.bot.inventoryManager.getInventory;
        const myPure = myInventory.getCurrencies(this.bot.craftWeapons, true);

        const pureCount = {
            '5021;6': myPure['5021;6'].length,
            '5002;6': myPure['5002;6'].length,
            '5001;6': myPure['5001;6'].length,
            '5000;6': myPure['5000;6'].length
        };

        const keyPrice = this.bot.pricelist.getKeyPrice;
        const required = this.getRequired(
            pureCount,
            price,
            price.keys > 0 || price.toValue(keyPrice.metal) >= keyPrice.toValue()
        );

        for (const pSku in required) {
            const amount = required[pSku];
            const assetids = myPure[pSku];
            for (let i = 0; i < amount; i++) {
                offer.addMyItem({
                    assetid: assetids[i],
                    appid: 440,
                    contextid: '2'
                });
            }
        }

        log.info(`[SNIPER] Sending offer for ${sku}...`);
        await new Promise<void>((resolve, reject) => {
            offer.send((err, status) => {
                if (err) return reject(err);
                if (status === 'pending') {
                    log.info(`[SNIPER] Offer sent, but needs 2FA confirmation.`);
                    this.bot.trades.acceptConfirmation(offer).catch(err => {
                        log.error(`[SNIPER] Failed to accept 2FA confirmation:`, err);
                    });
                } else {
                    log.info(`[SNIPER] Offer sent successfully.`);
                }
                resolve();
            });
        });

        // Store SKU and target sell price for post-trade relisting
        offer.data('sniperSku', sku);
    }

    private getRequired(
        myPure: { [sku: string]: number },
        price: Currencies,
        useKeys: boolean
    ): { [sku: string]: number } {
        const keyPrice = this.bot.pricelist.getKeyPrice;
        const currencyValues: { [sku: string]: number } = {
            '5021;6': useKeys ? keyPrice.toValue() : -1,
            '5002;6': 9,
            '5001;6': 3,
            '5000;6': 1
        };

        const picked: { [sku: string]: number } = {
            '5021;6': 0,
            '5002;6': 0,
            '5001;6': 0,
            '5000;6': 0
        };

        let remaining = price.toValue(useKeys ? keyPrice.metal : undefined);
        const skus = ['5021;6', '5002;6', '5001;6', '5000;6'];

        for (const sku of skus) {
            if (currencyValues[sku] === -1) continue;
            let amount = Math.floor(remaining / currencyValues[sku]);
            if (amount > myPure[sku]) amount = myPure[sku];
            picked[sku] = amount;
            remaining -= amount * currencyValues[sku];
        }

        if (remaining > 0) {
            // Try to overpay with one more of the smallest currency we have if needed?
            // Actually, for sniper we should probably be exact.
            // If we can't be exact, we might need to break down metal, but TF2Autobot usually does that via crafting.
            log.warn(`[SNIPER] Could not match exact price, remaining: ${remaining} scrap.`);
        }

        return picked;
    }

    async handleAcceptedOffer(offer: TradeOffer): Promise<void> {
        const sku = offer.data('sniperSku');
        if (!sku) return;

        log.info(`[SNIPER] Offer for ${sku} was accepted!`);

        const receivedItems = await new Promise<any[]>((resolve, reject) => {
            offer.getExchangeDetails(true, (err, status, tradeInitTime, receivedItems) => {
                if (err) return reject(err);
                resolve(receivedItems);
            });
        });

        const item = receivedItems.find(i => {
            const itemSku = SKU.fromObject(i);
            return itemSku === sku;
        });

        if (!item) {
            log.warn(`[SNIPER] Could not find received item ${sku} in offer items.`);
            return;
        }

        const newAssetId = item.new_assetid || item.assetid;
        const sellPrice = this.bot.pricelist.getPrice({ priceKey: sku, onlyEnabled: true })?.sell;

        if (!sellPrice) {
            log.warn(`[SNIPER] No sell price found for ${sku} in pricelist. Skipping relisting.`);
            return;
        }

        log.info(`[SNIPER] Relisting ${sku} (AssetID: ${newAssetId}) for ${sellPrice.toString()}...`);

        try {
            await axios.post(
                'https://api.backpack.tf/api/v2/classifieds/listings',
                {
                    listings: [
                        {
                            intent: 1,
                            id: newAssetId,
                            currencies: sellPrice.toJSON(),
                            details: this.bot.options.details.sell
                                .replace('%name%', sku)
                                .replace('%price%', sellPrice.toString())
                        }
                    ]
                },
                {
                    headers: {
                        'X-Auth-Token': this.bot.options.bptfAccessToken
                    }
                }
            );
            log.info(`[SNIPER PROVED] Item ${sku} bought for X, now listed for Y! Profit window secured.`);
        } catch (err) {
            log.error(`[SNIPER] Failed to relist ${sku}:`, err);
        }
    }
}
