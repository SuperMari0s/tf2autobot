import axios from 'axios';
import axiosRetry from 'axios-retry';
import SteamID from 'steamid';
import cheerio from 'cheerio';
import Bot from './Bot';
import log from '../lib/logger';
import Currencies from '@tf2autobot/tf2-currencies';
import SKU from '@tf2autobot/tf2-sku';
import UserCart from './Carts/UserCart';
import { ParsedPrice } from './Pricelist';
import { testPriceKey } from '../lib/tools/export';
import BptfWebSocket, { BptfListing } from './BptfWebSocket';

// Configure axios with retries and better resilience
axiosRetry(axios, {
    retries: 3,
    retryDelay: retryCount => axiosRetry.exponentialDelay(retryCount),
    retryCondition: error => {
        return axiosRetry.isNetworkOrIdempotentRequestError(error) || error.response?.status === 429;
    }
});

interface CachedListing {
    steamid: string;
    intent: 'buy' | 'sell';
    price: Currencies;
    tradeOfferUrl?: string;
    isAutomatic: boolean;
    timestamp: number;
}

export default class AutoTrade {
    private autoTradeTimeout: NodeJS.Timeout;

    private sniperTimeout: NodeJS.Timeout;

    private ws: BptfWebSocket;

    private buyOrderCache: Map<string, CachedListing[]> = new Map();

    private readonly userAgents = [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0'
    ];

    private isCheckingAutoTrade = false;

    private isCheckingSniper = false;

    constructor(private readonly bot: Bot) {
        this.ws = new BptfWebSocket();
        this.ws.on('listing', (sku: string, listing: BptfListing) => {
            void this.handleWsListing(sku, listing);
        });
    }

    start(): void {
        this.stop();
        this.ws.connect();
        this.planAutoTrade();
        this.planSniper();
    }

    stop(): void {
        clearTimeout(this.autoTradeTimeout);
        clearTimeout(this.sniperTimeout);
        this.ws.disconnect();
    }

    private planAutoTrade = (): void => {
        const { minInterval, maxInterval, enable } = this.bot.options.autoTrade;
        if (!enable) return;

        const interval = Math.floor(Math.random() * (maxInterval - minInterval + 1) + minInterval) * 60 * 1000;
        this.autoTradeTimeout = setTimeout(() => {
            void this.checkAutoTrade().finally(() => {
                this.planAutoTrade();
            });
        }, interval);
    };

    private planSniper = (): void => {
        const { minInterval, maxInterval, enable } = this.bot.options.sniper;
        if (!enable) return;

        const interval = Math.floor(Math.random() * (maxInterval - minInterval + 1) + minInterval) * 60 * 1000;
        this.sniperTimeout = setTimeout(() => {
            void this.checkSniper().finally(() => {
                this.planSniper();
            });
        }, interval);
    };

    private async handleWsListing(sku: string, listing: BptfListing): Promise<void> {
        const intent = listing.intent === 0 ? 'buy' : 'sell';
        const price = listing.price;

        // Update cache for AutoTrade
        if (intent === 'buy') {
            const current = this.buyOrderCache.get(sku) || [];
            // Remove existing from same user
            const filtered = current.filter(l => l.steamid !== listing.steamid);
            filtered.push({
                steamid: listing.steamid,
                intent: 'buy',
                price,
                tradeOfferUrl: listing.tradeOfferUrl,
                isAutomatic: listing.isAutomatic,
                timestamp: Date.now()
            });
            // Keep only last 20 listings per SKU and prune older than 30 mins
            const now = Date.now();
            const pruned = filtered.filter(l => now - l.timestamp < 30 * 60 * 1000).slice(-20);
            this.buyOrderCache.set(sku, pruned);

            // Instant AutoTrade check if we have this in stock
            const inventory = this.bot.inventoryManager.getInventory;
            const entry = this.bot.pricelist.getPrice({ priceKey: sku });
            if (entry && entry.enabled && entry.intent !== 0) {
                const amountInStock = inventory.getAmount({
                    priceKey: sku,
                    includeNonNormalized: false,
                    tradableOnly: true
                });
                if (amountInStock > 0) {
                    const keyPrice = this.bot.pricelist.getKeyPrice.metal;
                    if (listing.isAutomatic && listing.price.toValue(keyPrice) >= entry.sell.toValue(keyPrice)) {
                        if (listing.steamid !== this.bot.client.steamID.getSteamID64()) {
                            log.info(`[AutoTrade] Instant match for ${entry.name} from stream!`);
                            await this.sendOffer(listing.steamid, sku, 'selling', listing.price, listing.tradeOfferUrl);
                        }
                    }
                }
            }
        }

        // Sniper reaction
        if (this.bot.options.sniper.enable && intent === 'sell' && listing.isAutomatic) {
            const { items } = this.bot.options.sniper;
            if (items.some(i => i === sku || this.bot.schema.getSkuFromName(i) === sku)) {
                await this.evaluateDeal(sku, listing);
            }
        }
    }

    private async evaluateDeal(sku: string, listing: BptfListing | CachedListing): Promise<void> {
        if (this.bot.isHalted) return;
        if (listing.steamid === this.bot.client.steamID.getSteamID64()) return;

        const suggestedValue = await this.bot.pricelist.getItemPrices(sku);
        if (!suggestedValue || !suggestedValue.sell) return;

        const keyPrice = this.bot.pricelist.getKeyPrice.metal;
        const suggestedSellValue = suggestedValue.sell.toValue(keyPrice);
        const listingValue = listing.price.toValue(keyPrice);
        const profit = (suggestedSellValue - listingValue) / 9;

        if (profit >= (this.bot.options.sniper.minProfit || 0)) {
            log.info(`[Sniper] Deal caught for ${sku}: ${profit.toFixed(2)} ref profit!`);
            if (this.canAfford(listing.price)) {
                await this.sendOffer(listing.steamid, sku, 'buying', listing.price, listing.tradeOfferUrl);
            }
        }
    }

    private async checkAutoTrade(): Promise<void> {
        if (this.bot.isHalted || this.isCheckingAutoTrade) return;
        this.isCheckingAutoTrade = true;

        try {
            const inventory = this.bot.inventoryManager.getInventory;
            const pricelist = this.bot.pricelist.getPrices;

            const skusInStock = Object.keys(pricelist).filter(sku => {
                const entry = pricelist[sku];
                if (!entry.enabled || entry.intent === 0) return false;
                return (
                    inventory.getAmount({
                        priceKey: sku,
                        includeNonNormalized: false,
                        tradableOnly: true
                    }) > 0
                );
            });

            if (skusInStock.length === 0) return;

            log.debug(`Checking cache/scraping for ${skusInStock.length} items in stock...`);

            for (const sku of skusInStock) {
                if (this.bot.isHalted) break;

                const entry = pricelist[sku];
                const cached = this.buyOrderCache.get(sku) || [];
                let matched = false;

                // Try cache first
                for (const listing of cached) {
                    const keyPrice = this.bot.pricelist.getKeyPrice.metal;
                    if (listing.isAutomatic && listing.price.toValue(keyPrice) >= entry.sell.toValue(keyPrice)) {
                        if (listing.steamid === this.bot.client.steamID.getSteamID64()) continue;
                        log.info(`[AutoTrade] Found matching buy order in cache for ${entry.name}`);
                        await this.sendOffer(listing.steamid, sku, 'selling', listing.price, listing.tradeOfferUrl);
                        matched = true;
                        break;
                    }
                }

                if (!matched) {
                    // Fallback scraping with a very long delay to avoid bans
                    try {
                        const listings = await this.scrapeClassifieds(sku);
                        const buyOrders = listings.filter(l => l.intent === 'buy' && l.isAutomatic);
                        for (const listing of buyOrders) {
                            if (listing.steamid === this.bot.client.steamID.getSteamID64()) continue;
                            const keyPrice = this.bot.pricelist.getKeyPrice.metal;
                            if (listing.price.toValue(keyPrice) >= entry.sell.toValue(keyPrice)) {
                                log.info(`[AutoTrade] Found matching buy order via scrape for ${entry.name}`);
                                await this.sendOffer(
                                    listing.steamid,
                                    sku,
                                    'selling',
                                    listing.price,
                                    listing.tradeOfferUrl
                                );
                                break;
                            }
                        }
                        // Long delay between scrapes
                        const delay = Math.floor(Math.random() * 60000) + 60000; // 1-2 mins
                        await new Promise(resolve => setTimeout(resolve, delay));
                    } catch (err) {
                        log.warn(`[AutoTrade] Scrape failed for ${sku}:`, (err as Error).message);
                        await new Promise(resolve => setTimeout(resolve, 120000)); // Cool down longer on error
                    }
                }
            }
        } finally {
            this.isCheckingAutoTrade = false;
        }
    }

    private async checkSniper(): Promise<void> {
        if (this.bot.isHalted || this.isCheckingSniper) return;
        this.isCheckingSniper = true;

        try {
            const { items } = this.bot.options.sniper;
            if (!items || items.length === 0) return;

            log.debug(`Sniper: Periodically checking ${items.length} items for deals...`);
            for (const itemQuery of items) {
                if (this.bot.isHalted) break;
                try {
                    const sku = testPriceKey(itemQuery) ? itemQuery : this.bot.schema.getSkuFromName(itemQuery);
                    if (sku.includes('null') || sku.includes('undefined')) continue;

                    const listings = await this.scrapeClassifieds(sku);
                    const sellOrders = listings.filter(l => l.intent === 'sell' && l.isAutomatic);
                    for (const listing of sellOrders) {
                        await this.evaluateDeal(sku, { ...listing, timestamp: Date.now() });
                    }
                    await new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * 60000) + 60000));
                } catch (err) {
                    log.warn(`[Sniper] Scrape failed for ${itemQuery}:`, (err as Error).message);
                    await new Promise(resolve => setTimeout(resolve, 120000));
                }
            }
        } finally {
            this.isCheckingSniper = false;
        }
    }

    private async scrapeClassifieds(sku: string): Promise<CachedListing[]> {
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
                'User-Agent': userAgent,
                Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
                Referer: 'https://backpack.tf/',
                Connection: 'keep-alive',
                'Upgrade-Insecure-Requests': '1',
                Pragma: 'no-cache',
                'Cache-Control': 'no-cache'
            },
            jar: this.bot.jar,
            withCredentials: true,
            timeout: 20000
        });

        const $ = cheerio.load(response.data);
        const listings: CachedListing[] = [];

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
                    tradeOfferUrl: tradeUrl,
                    isAutomatic,
                    timestamp: Date.now()
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
            const suggestedValue = await this.bot.pricelist.getItemPrices(sku);
            if (entry) {
                await this.bot.pricelist.updatePrice({
                    priceKey: sku,
                    entryData: { ...entry.getJSON(), buy: price.toJSON(), autoprice: false, intent: 2 },
                    emitChange: false
                });
            } else {
                await this.bot.pricelist
                    .addPrice({
                        entryData: {
                            sku,
                            enabled: true,
                            autoprice: false,
                            min: 0,
                            max: 1,
                            intent: 0,
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
            token || '',
            this.bot,
            this.bot.options.miscSettings.weaponsAsCurrency.enable ? this.bot.craftWeapons : [],
            this.bot.options.miscSettings.weaponsAsCurrency.enable &&
                this.bot.options.miscSettings.weaponsAsCurrency.withUncraft
                ? this.bot.uncraftWeapons
                : []
        );

        if (intent === 'selling') cart.addOurItem(sku, 1);
        else cart.addTheirItem(sku, 1);

        try {
            await cart.constructOffer();
            await this.bot.trades.sendOffer(cart.getOffer);
            log.info(`Sent offer to ${partnerSteamID} for ${sku} (${intent})`);
        } catch (err) {
            log.error(`Failed to send offer to ${partnerSteamID}:`, (err as Error).message);
        } finally {
            if (intent === 'buying') {
                const suggestedValue = await this.bot.pricelist.getItemPrices(sku);
                this.autoResell(sku, suggestedValue);
            } else if (intent === 'selling' && entry) {
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

        if (maxBudget !== -1 && priceValue > (maxBudget || 0) * 9) return false;
        return totalPureValue >= priceValue;
    }

    private autoResell(sku: string, suggestedValue: ParsedPrice | null): void {
        const entry = this.bot.pricelist.getPrice({ priceKey: sku });
        if (entry) {
            void this.bot.pricelist
                .updatePrice({
                    priceKey: sku,
                    entryData: {
                        ...entry.getJSON(),
                        enabled: true,
                        autoprice: true,
                        intent: 1,
                        buy: suggestedValue?.buy?.toJSON() || entry.buy.toJSON(),
                        sell: suggestedValue?.sell?.toJSON() || entry.sell.toJSON()
                    },
                    emitChange: true
                })
                .catch(err => {
                    log.error(`Failed to update ${sku} to sell:`, (err as Error).message);
                });
            return;
        }
        if (!suggestedValue || !suggestedValue.buy || !suggestedValue.sell) return;
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
            .catch(err => {
                log.error(`Failed to auto-add ${sku} to pricelist:`, (err as Error).message);
            });
    }
}
