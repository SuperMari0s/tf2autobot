import axios from 'axios';
import SteamID from 'steamid';
import Bot from './Bot';
import log from '../lib/logger';
import { apiRequest } from '../lib/apiRequest';
import Currencies from '@tf2autobot/tf2-currencies';
import SKU from '@tf2autobot/tf2-sku';
import UserCart from './Carts/UserCart';
import { ParsedPrice } from './Pricelist';
import { testPriceKey } from '../lib/tools/export';

interface ClassifiedListing {
    id: string;
    steamid: string;
    appid: number;
    currencies: {
        keys: number;
        metal: number;
    };
    item: any;
    intent: number;
    userAgent?: string;
}

export default class AutoTrade {
    private snapshotTimeout: NodeJS.Timeout;

    private sniperSkus: Set<string> = new Set();

    private lastSniperItemsConfig: string[] = [];

    constructor(private readonly bot: Bot) {}

    start(): void {
        this.stop();
        this.planSnapshot();
    }

    stop(): void {
        clearTimeout(this.snapshotTimeout);
    }

    private planSnapshot(): void {
        const { minInterval, maxInterval, enable: autoTradeEnable } = this.bot.options.autoTrade;
        const { enable: sniperEnable } = this.bot.options.sniper;

        if (!autoTradeEnable && !sniperEnable) return;

        // Use the AutoTrade interval for the snapshot frequency
        const interval = Math.floor(Math.random() * (maxInterval - minInterval + 1) + minInterval) * 60 * 1000;
        this.snapshotTimeout = setTimeout(() => {
            void this.checkOpportunities().finally(() => this.planSnapshot());
        }, interval);
    }

    private async updateSniperSkus(): Promise<void> {
        const currentItems = this.bot.options.sniper.items || [];
        if (JSON.stringify(currentItems) === JSON.stringify(this.lastSniperItemsConfig)) return;

        this.sniperSkus.clear();
        for (const item of currentItems) {
            if (testPriceKey(item)) {
                this.sniperSkus.add(item);
            } else {
                const sku = this.bot.schema.getSkuFromName(item);
                if (!sku.includes('null') && !sku.includes('undefined')) this.sniperSkus.add(sku);
            }
        }
        this.lastSniperItemsConfig = [...currentItems];
    }

    private async checkOpportunities(): Promise<void> {
        if (this.bot.isHalted) return;

        const autoTradeEnabled = this.bot.options.autoTrade.enable;
        const sniperEnabled = this.bot.options.sniper.enable;

        if (!autoTradeEnabled && !sniperEnabled) return;

        log.debug('Checking opportunities via classifieds snapshot...');

        try {
            const snapshotUrl = await this.getSnapshotUrl();
            const response = await axios.get(snapshotUrl, {
                maxContentLength: Infinity,
                maxBodyLength: Infinity,
                responseType: 'json',
                timeout: 60000
            });

            const listings = response.data.listings;
            if (!listings || !Array.isArray(listings)) return;

            log.debug(`Fetched snapshot with ${listings.length} listings.`);

            await this.updateSniperSkus();
            const pricelist = this.bot.pricelist.getPrices;
            const inventory = this.bot.inventoryManager.getInventory;
            const keyPrice = this.bot.pricelist.getKeyPrice.metal;
            const sniperMinProfit = this.bot.options.sniper.minProfit || 0.33;

            const potentialTrades: Map<string, { sku: string; intent: 'buying' | 'selling' }[]> = new Map();
            const suggestedValueCache: Map<string, ParsedPrice | null> = new Map();

            for (const listing of listings) {
                if (listing.steamid === this.bot.client.steamID.getSteamID64()) continue;

                const mightBeTarget =
                    (autoTradeEnabled && listing.intent === 0) || (sniperEnabled && listing.intent === 1);

                if (!mightBeTarget) continue;

                const sku = SKU.fromObject(listing.item);
                const listingPrice = new Currencies(listing.currencies);

                if (listing.intent === 0 && autoTradeEnabled) {
                    const entry = pricelist[sku];
                    if (entry && entry.enabled && entry.intent !== 0) {
                        const amountInStock = inventory.getAmount({
                            priceKey: sku,
                            includeNonNormalized: false,
                            tradableOnly: true
                        });
                        if (amountInStock > 0 && listingPrice.toValue(keyPrice) >= entry.sell.toValue(keyPrice)) {
                            this.addPotentialTrade(potentialTrades, listing.steamid, sku, 'selling');
                        }
                    }
                } else if (listing.intent === 1 && sniperEnabled && this.sniperSkus.has(sku)) {
                    let suggestedValue = suggestedValueCache.get(sku);
                    if (suggestedValue === undefined) {
                        suggestedValue = await this.bot.pricelist.getItemPrices(sku);
                        suggestedValueCache.set(sku, suggestedValue);
                    }

                    if (suggestedValue && suggestedValue.sell) {
                        const listingValue = listingPrice.toValue(keyPrice);
                        const suggestedSellValue = suggestedValue.sell.toValue(keyPrice);
                        const profit = (suggestedSellValue - listingValue) / 9;

                        if (profit >= sniperMinProfit && this.canAfford(listingPrice)) {
                            this.addPotentialTrade(potentialTrades, listing.steamid, sku, 'buying');
                        }
                    }
                }
            }

            if (potentialTrades.size > 0) {
                log.info(`Found ${potentialTrades.size} potential partners. Fetching trade URLs...`);
                await this.processPotentialTrades(potentialTrades);
            }
        } catch (err) {
            log.error('Error in AutoTrade/Sniper cycle:', err);
        }
    }

    private addPotentialTrade(
        map: Map<string, { sku: string; intent: 'buying' | 'selling' }[]>,
        steamid: string,
        sku: string,
        intent: 'buying' | 'selling'
    ): void {
        const existing = map.get(steamid) || [];
        if (existing.some(e => e.sku === sku && e.intent === intent)) return;
        existing.push({ sku, intent });
        map.set(steamid, existing);
    }

    private async getSnapshotUrl(): Promise<string> {
        const response = await apiRequest<any>({
            method: 'GET',
            url: 'https://api.backpack.tf/api/classifieds/snapshot/v1',
            params: {
                key: this.bot.options.bptfApiKey,
                appid: 440
            }
        });

        if (!response || !response.url) {
            throw new Error(`Failed to get snapshot URL: ${JSON.stringify(response)}`);
        }

        return response.url;
    }

    private async processPotentialTrades(
        potentialTrades: Map<string, { sku: string; intent: 'buying' | 'selling' }[]>
    ): Promise<void> {
        const steamIDs = Array.from(potentialTrades.keys());
        for (let i = 0; i < steamIDs.length; i += 100) {
            const batch = steamIDs.slice(i, i + 100);
            try {
                const userInfo = await this.getUsersInfo(batch);
                for (const steamID64 of batch) {
                    const user = userInfo.users[steamID64];
                    const tradeUrl = user?.tradeoffer_url;
                    if (tradeUrl) {
                        const trades = potentialTrades.get(steamID64);
                        for (const trade of trades) {
                            await this.sendOffer(steamID64, trade.sku, trade.intent, tradeUrl);
                            await new Promise(resolve => setTimeout(resolve, 2000));
                        }
                    }
                }
            } catch (err) {
                log.error('Error fetching user info for batch:', err);
            }
        }
    }

    private async getUsersInfo(steamIDs: string[]): Promise<any> {
        return apiRequest<any>({
            method: 'GET',
            url: 'https://api.backpack.tf/api/users/info/v1',
            params: {
                key: this.bot.options.bptfApiKey,
                steamids: steamIDs.join(',')
            }
        });
    }

    private async sendOffer(
        partnerSteamID: string,
        sku: string,
        intent: 'buying' | 'selling',
        tradeUrl: string
    ): Promise<void> {
        const partner = new SteamID(partnerSteamID);

        if (this.bot.trades.getActiveOffer(partner) !== null) {
            return;
        }

        const token = new URL(tradeUrl).searchParams.get('token');
        const cart = new UserCart(partner, token, this.bot, this.bot.craftWeapons, this.bot.uncraftWeapons);

        if (intent === 'selling') {
            cart.addOurItem(sku, 1);
        } else {
            cart.addTheirItem(sku, 1);
        }

        try {
            await cart.constructOffer();
            await cart.sendOffer();
            log.info(`Sent offer to ${partnerSteamID} for ${sku} (${intent})`);

            if (intent === 'buying') {
                const suggestedValue = await this.bot.pricelist.getItemPrices(sku);
                if (suggestedValue) {
                    this.autoResell(sku, suggestedValue);
                }
            }
        } catch (err) {
            log.error(`Failed to send offer to ${partnerSteamID}:`, err);
        }
    }

    private canAfford(price: Currencies): boolean {
        const { maxBudget } = this.bot.options.sniper;
        const pureValue = this.bot.inventoryManager.getPureValue;
        const keyPrice = this.bot.pricelist.getKeyPrice.metal;

        const totalPureValue = pureValue.keys * keyPrice + pureValue.metal * 9;
        const priceValue = price.toValue(keyPrice);

        if (maxBudget !== -1 && priceValue > (maxBudget ?? 0) * 9) return false;

        return totalPureValue >= priceValue;
    }

    private autoResell(sku: string, suggestedValue: ParsedPrice): void {
        const entry = this.bot.pricelist.getPrice({ priceKey: sku });
        if (entry) return;

        void this.bot.pricelist
            .addPrice({
                entryData: {
                    sku,
                    enabled: true,
                    autoprice: true,
                    min: 0,
                    max: 1,
                    intent: 1, // sell only
                    buy: suggestedValue.buy,
                    sell: suggestedValue.sell
                },
                emitChange: true
            })
            .catch(err => log.error(`Failed to auto-add ${sku} to pricelist:`, err));
    }
}
