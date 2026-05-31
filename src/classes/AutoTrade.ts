import axios from 'axios';
import SteamID from 'steamid';
import cheerio from 'cheerio';
import Bot from './Bot';
import log from '../lib/logger';
import Currencies from '@tf2autobot/tf2-currencies';
import SKU from '@tf2autobot/tf2-sku';
import UserCart from './Carts/UserCart';
import { ParsedPrice } from './Pricelist';
import { testPriceKey } from '../lib/tools/export';

interface ScrapedListing {
    steamid: string;
    intent: 'buy' | 'sell';
    price: Currencies;
    tradeUrl?: string;
    isAutomatic: boolean;
}

export default class AutoTrade {
    private autoTradeTimeout: NodeJS.Timeout;

    private sniperTimeout: NodeJS.Timeout;

    private readonly userAgents = [
        'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    ];

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
        const { minInterval, maxInterval, enable } = this.bot.options.sniper;
        if (!enable) return;

        const interval = Math.floor(Math.random() * (maxInterval - minInterval + 1) + minInterval) * 60 * 1000;
        this.sniperTimeout = setTimeout(() => {
            void this.checkSniper().finally(() => this.planSniper());
        }, interval);
    }

    private async checkAutoTrade(): Promise<void> {
        if (this.bot.isHalted) return;

        const inventory = this.bot.inventoryManager.getInventory;
        const pricelist = this.bot.pricelist.getPrices;

        const skusToCheck = Object.keys(pricelist).filter(sku => {
            const entry = pricelist[sku];
            if (!entry.enabled || entry.intent === 0) return false;

            const amountInStock = inventory.getAmount({
                priceKey: sku,
                includeNonNormalized: false,
                tradableOnly: true
            });
            return amountInStock > 0;
        });

        if (skusToCheck.length === 0) return;

        log.debug(`Checking auto-trade opportunities for ${skusToCheck.length} items...`);

        for (const sku of skusToCheck) {
            if (this.bot.isHalted) break;

            try {
                const listings = await this.scrapeClassifieds(sku);
                const buyOrders = listings.filter(l => l.intent === 'buy' && l.isAutomatic);
                const entry = pricelist[sku];

                for (const listing of buyOrders) {
                    if (listing.steamid === this.bot.client.steamID.getSteamID64()) continue;

                    const keyPrice = this.bot.pricelist.getKeyPrice.metal;
                    if (listing.price.toValue(keyPrice) >= entry.sell.toValue(keyPrice)) {
                        log.info(`Found matching buy order for ${entry.name} from ${listing.steamid}`);
                        await this.sendOffer(listing.steamid, sku, 'selling', listing.price, listing.tradeUrl);
                        break;
                    }
                }
                // Randomized delay between 15-30s to avoid bans
                const delay = Math.floor(Math.random() * 15000) + 15000;
                await new Promise(resolve => setTimeout(resolve, delay));
            } catch (err) {
                log.error(`Error in AutoTrade for ${sku}:`, err);
                await new Promise(resolve => setTimeout(resolve, 60000)); // Cool down on error
            }
        }
    }

    private async checkSniper(): Promise<void> {
        if (this.bot.isHalted) return;

        const { items, minProfit } = this.bot.options.sniper;
        if (!items || items.length === 0) return;

        log.debug(`Checking sniping opportunities for ${items.length} configured items...`);

        for (const itemQuery of items) {
            if (this.bot.isHalted) break;

            try {
                let sku: string;
                let name: string;

                if (testPriceKey(itemQuery)) {
                    sku = itemQuery;
                    name = this.bot.schema.getName(SKU.fromString(sku), false);
                } else {
                    sku = this.bot.schema.getSkuFromName(itemQuery);
                    name = itemQuery;
                }

                if (sku.includes('null') || sku.includes('undefined')) continue;

                const listings = await this.scrapeClassifieds(sku);
                const sellOrders = listings.filter(l => l.intent === 'sell' && l.isAutomatic);
                const suggestedValue = await this.bot.pricelist.getItemPrices(sku);
                if (!suggestedValue || !suggestedValue.sell) continue;

                const keyPrice = this.bot.pricelist.getKeyPrice.metal;
                const suggestedSellValue = suggestedValue.sell.toValue(keyPrice);

                for (const listing of sellOrders) {
                    if (listing.steamid === this.bot.client.steamID.getSteamID64()) continue;

                    const listingValue = listing.price.toValue(keyPrice);
                    const profit = (suggestedSellValue - listingValue) / 9;

                    if (profit >= minProfit) {
                        log.info(`Found deal for ${name}: ${profit.toFixed(2)} ref profit!`);
                        if (this.canAfford(listing.price)) {
                            await this.sendOffer(listing.steamid, sku, 'buying', listing.price, listing.tradeUrl);
                        }
                        break;
                    }
                }
                const delay = Math.floor(Math.random() * 15000) + 15000;
                await new Promise(resolve => setTimeout(resolve, delay));
            } catch (err) {
                log.error(`Error in Sniper for ${itemQuery}:`, err);
                await new Promise(resolve => setTimeout(resolve, 60000));
            }
        }
    }

    private async scrapeClassifieds(sku: string): Promise<ScrapedListing[]> {
        const item = SKU.fromString(sku);
        const itemName = this.bot.schema.getName(item, false);

        const url = `https://backpack.tf/classifieds?item=${encodeURIComponent(itemName)}&quality=${
            item.quality
        }&tradable=${item.tradable ? 1 : 0}&craftable=${item.craftable ? 1 : 0}${
            item.australium ? '&australium=1' : ''
        }${item.effect ? `&effect=${item.effect}` : ''}`;

        const userAgent = this.userAgents[Math.floor(Math.random() * this.userAgents.length)];

        const response = await axios.get<string>(url, {
            headers: {
                'User-Agent': userAgent
            },
            timeout: 30000
        });

        const $ = cheerio.load(response.data);
        const listings: ScrapedListing[] = [];

        $('.media-list .media.listing').each((i, elem) => {
            const $el = $(elem);
            const steamid = $el.attr('data-listing-steamid');
            const intent = $el.attr('data-listing-intent') === '1' ? 'sell' : 'buy';
            const priceKeys = parseFloat($el.attr('data-listing-price-keys') || '0');
            const priceMetal = parseFloat($el.attr('data-listing-price-metal') || '0');
            const tradeUrl = $el.find('.listing-buttons a[href*="tradeoffer/new"]').attr('href');
            const isAutomatic = $el.find('.fa-flash').length > 0 || $el.find('.listing-label-lightning').length > 0;

            if (steamid) {
                listings.push({
                    steamid,
                    intent,
                    price: new Currencies({ keys: priceKeys, metal: priceMetal }),
                    tradeUrl,
                    isAutomatic
                });
            }
        });

        return listings;
    }

    private async sendOffer(
        partnerSteamID: string,
        sku: string,
        intent: 'buying' | 'selling',
        price: Currencies,
        tradeUrl?: string
    ): Promise<void> {
        const partner = new SteamID(partnerSteamID);

        if (this.bot.trades.getActiveOffer(partner) !== null) return;

        let token: string | null = null;
        if (tradeUrl) {
            try {
                token = new URL(tradeUrl).searchParams.get('token');
            } catch (_) {
                // ignore
            }
        }

        const entry = this.bot.pricelist.getPrice({ priceKey: sku });

        if (intent === 'selling') {
            if (!entry) return;
            const keyPrice = this.bot.pricelist.getKeyPrice.metal;
            if (price.toValue(keyPrice) > entry.sell.toValue(keyPrice)) {
                await this.bot.pricelist.updatePrice({
                    priceKey: sku,
                    entryData: { ...entry.getJSON(), sell: price.toJSON(), autoprice: false },
                    emitChange: false
                });
            }
        } else {
            // Sniper logic - item might not be in pricelist
            const suggestedValue = await this.bot.pricelist.getItemPrices(sku);

            if (entry) {
                // Already in pricelist, update buy price to match deal
                await this.bot.pricelist.updatePrice({
                    priceKey: sku,
                    entryData: {
                        ...entry.getJSON(),
                        buy: price.toJSON(),
                        autoprice: false,
                        intent: 2 // banking so we can buy it
                    },
                    emitChange: false
                });
            } else {
                // Not in pricelist, add it so UserCart knows what to do
                await this.bot.pricelist
                    .addPrice({
                        entryData: {
                            sku,
                            enabled: true,
                            autoprice: false,
                            min: 0,
                            max: 1,
                            intent: 0, // buy
                            buy: price.toJSON(),
                            sell: suggestedValue?.sell?.toJSON() || price.toJSON()
                        },
                        emitChange: false
                    })
                    .catch(() => {});
            }
        }

        const cart = new UserCart(
            partner,
            token,
            this.bot,
            this.bot.options.miscSettings.weaponsAsCurrency.enable ? this.bot.craftWeapons : [],
            this.bot.options.miscSettings.weaponsAsCurrency.enable &&
                this.bot.options.miscSettings.weaponsAsCurrency.withUncraft
                ? this.bot.uncraftWeapons
                : []
        );

        if (intent === 'selling') {
            cart.addOurItem(sku, 1);
        } else {
            cart.addTheirItem(sku, 1);
        }

        try {
            await cart.constructOffer();
            await this.bot.trades.sendOffer(cart.getOffer);
            log.info(`Sent offer to ${partnerSteamID} for ${sku} (${intent})`);
        } catch (err) {
            log.error(`Failed to send offer to ${partnerSteamID}:`, err);
        } finally {
            if (intent === 'buying') {
                const suggestedValue = await this.bot.pricelist.getItemPrices(sku);
                this.autoResell(sku, suggestedValue);
            } else if (intent === 'selling' && entry) {
                // Restore original price if it was temporarily modified
                await this.bot.pricelist
                    .updatePrice({
                        priceKey: sku,
                        entryData: entry.getJSON(),
                        emitChange: false
                    })
                    .catch(() => {});
            }
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

        if (entry) {
            void this.bot.pricelist
                .updatePrice({
                    priceKey: sku,
                    entryData: {
                        ...entry.getJSON(),
                        enabled: true,
                        autoprice: true,
                        intent: 1, // sell
                        buy: suggestedValue?.buy?.toJSON() || entry.buy.toJSON(),
                        sell: suggestedValue?.sell?.toJSON() || entry.sell.toJSON()
                    },
                    emitChange: true
                })
                .catch(err => log.error(`Failed to update ${sku} to sell:`, err));
            return;
        }

        if (!suggestedValue) return;

        void this.bot.pricelist
            .addPrice({
                entryData: {
                    sku,
                    enabled: true,
                    autoprice: true,
                    min: 0,
                    max: 1,
                    intent: 1,
                    buy: suggestedValue.buy.toJSON(),
                    sell: suggestedValue.sell.toJSON()
                },
                emitChange: true
            })
            .catch(err => log.error(`Failed to auto-add ${sku} to pricelist:`, err));
    }
}
