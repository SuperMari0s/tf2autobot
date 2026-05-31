import SteamID from 'steamid';
import Bot from './Bot';
import log from '../lib/logger';
import { apiRequest } from '../lib/apiRequest';
import Currencies from '@tf2autobot/tf2-currencies';
import SKU from '@tf2autobot/tf2-sku';
import UserCart from './Carts/UserCart';
import { ParsedPrice } from './Pricelist';

interface ClassifiedsSearchResponse {
    buy: {
        total: number;
        listings: ClassifiedListing[];
    };
    sell: {
        total: number;
        listings: ClassifiedListing[];
    };
}

interface ClassifiedListing {
    id: string;
    steamid: string;
    appid: number;
    currencies: {
        keys: number;
        metal: number;
    };
    item: {
        id?: string;
        defindex: number;
        quality: number;
        attributes: any[];
    };
    intent: number;
    userAgent?: string;
}

export default class AutoTrade {
    private autoTradeTimeout: NodeJS.Timeout;

    private sniperTimeout: NodeJS.Timeout;

    constructor(private readonly bot: Bot) {}

    start(): void {
        this.stop();
        this.planAutoTrade();
        this.planSniper();
    }

    stop(): void {
        clearTimeout(this.autoTradeTimeout);
        clearTimeout(this.sniperTimeout);
    }

    private planAutoTrade(): void {
        const { minInterval, maxInterval, enable } = this.bot.options.autoTrade;
        if (!enable) return;

        const interval = Math.floor(Math.random() * (maxInterval - minInterval + 1) + minInterval) * 60 * 1000;
        this.autoTradeTimeout = setTimeout(() => {
            void this.checkAutoTrade().finally(() => this.planAutoTrade());
        }, interval);
    }

    private planSniper(): void {
        const { enable } = this.bot.options.sniper;
        if (!enable) return;

        // Sniper runs more frequently, e.g., every 2 minutes
        this.sniperTimeout = setTimeout(
            () => {
                void this.checkSniper().finally(() => this.planSniper());
            },
            2 * 60 * 1000
        );
    }

    private async checkAutoTrade(): Promise<void> {
        if (this.bot.isHalted) return;
        log.debug('Checking for auto-trade opportunities...');

        const inventory = this.bot.inventoryManager.getInventory;
        const pricelist = this.bot.pricelist.getPrices;

        for (const sku in pricelist) {
            if (!Object.prototype.hasOwnProperty.call(pricelist, sku)) continue;
            const entry = pricelist[sku];
            if (!entry.enabled || entry.intent === 0) continue;

            const amountInStock = inventory.getAmount({
                priceKey: sku,
                includeNonNormalized: false,
                tradableOnly: true
            });
            if (amountInStock <= 0) continue;

            try {
                const opportunities = await this.searchClassifieds(sku);
                if (!opportunities.buy || !opportunities.buy.listings) continue;

                for (const listing of opportunities.buy.listings) {
                    if (listing.steamid === this.bot.client.steamID.getSteamID64()) continue;

                    const listingPrice = new Currencies(listing.currencies);
                    const keyPrice = this.bot.pricelist.getKeyPrice.metal;

                    if (listingPrice.toValue(keyPrice) >= entry.sell.toValue(keyPrice)) {
                        log.info(`Found matching buy order for ${entry.name} from ${listing.steamid}`);
                        await this.sendOffer(listing.steamid, sku, 'selling');
                        break; // Only send one offer per item per cycle to be safe
                    }
                }
                // Rate limit spacing
                await new Promise(resolve => setTimeout(resolve, 5000));
            } catch (err) {
                log.error(`Error searching classifieds for ${sku}:`, err);
            }
        }
    }

    private async checkSniper(): Promise<void> {
        if (this.bot.isHalted) return;
        log.debug('Checking for sniping opportunities...');

        const { items, minProfit } = this.bot.options.sniper;
        if (!items || items.length === 0) return;

        for (const itemQuery of items) {
            try {
                let sku: string;
                let name: string;

                if (/^[0-9]+;[0-9]+/.test(itemQuery)) {
                    sku = itemQuery;
                    name = this.bot.schema.getName(SKU.fromString(sku), false);
                } else {
                    sku = this.bot.schema.getSkuFromName(itemQuery);
                    name = itemQuery;
                }

                if (sku.includes('null') || sku.includes('undefined')) {
                    log.warn(`Sniper: Could not find SKU for ${itemQuery}`);
                    continue;
                }

                const targetSku = sku;
                const opportunities = await this.searchClassifieds(targetSku);
                const suggestedValue = await this.bot.pricelist.getItemPrices(targetSku);
                if (!suggestedValue || !suggestedValue.sell) continue;

                if (!opportunities.sell || !opportunities.sell.listings) continue;

                const keyPrice = this.bot.pricelist.getKeyPrice.metal;
                const suggestedSellValue = suggestedValue.sell.toValue(keyPrice);

                for (const listing of opportunities.sell.listings) {
                    if (listing.steamid === this.bot.client.steamID.getSteamID64()) continue;

                    const listingPrice = new Currencies(listing.currencies);
                    const listingValue = listingPrice.toValue(keyPrice);
                    const profit = (suggestedSellValue - listingValue) / 9; // in refined

                    if (profit >= minProfit) {
                        log.info(`Found deal for ${name}: ${profit.toFixed(2)} ref profit!`);
                        if (this.canAfford(listingPrice)) {
                            await this.sendOffer(listing.steamid, targetSku, 'buying');
                            // After buying, we might want to add it to pricelist
                            this.autoResell(targetSku, suggestedValue);
                        } else {
                            log.debug(`Cannot afford deal for ${name}`);
                        }
                        break; // Only one deal per item type per cycle
                    }
                }
                // Rate limit spacing
                await new Promise(resolve => setTimeout(resolve, 5000));
            } catch (err) {
                log.error(`Error in sniper cycle for ${itemQuery}:`, err);
            }
        }
    }

    private async searchClassifieds(sku: string): Promise<ClassifiedsSearchResponse> {
        const item = SKU.fromString(sku);
        const params: Record<string, string | number> = {
            key: this.bot.options.bptfApiKey,
            item: this.bot.schema.getName(item, false),
            quality: item.quality,
            tradable: item.tradable ? 1 : 0,
            craftable: item.craftable ? 1 : 0
        };

        if (item.effect) params.effect = item.effect;
        if (item.australium) params.australium = 1;
        if (item.wear) params.wear = item.wear;
        if (item.paintkit) params.paintkit = item.paintkit;

        return apiRequest<ClassifiedsSearchResponse>({
            method: 'GET',
            url: 'https://api.backpack.tf/api/classifieds/search/v1',
            params
        });
    }

    private async sendOffer(partnerSteamID: string, sku: string, intent: 'buying' | 'selling'): Promise<void> {
        const partner = new SteamID(partnerSteamID);

        // Check for active offers to avoid duplicates
        if (this.bot.trades.getActiveOffer(partner) !== null) {
            log.debug(`Already have an active offer with ${partnerSteamID}, skipping.`);
            return;
        }

        const cart = new UserCart(partner, this.bot, this.bot.craftWeapons, this.bot.uncraftWeapons);

        if (intent === 'selling') {
            cart.addOurItem(sku, 1);
        } else {
            cart.addTheirItem(sku, 1);
        }

        try {
            const alteredMessage = await cart.constructOffer();
            if (alteredMessage) {
                log.warn(`Offer to ${partnerSteamID} was altered: ${alteredMessage}`);
            }
            await cart.sendOffer();
            log.info(`Sent offer to ${partnerSteamID} for ${sku} (${intent})`);
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
