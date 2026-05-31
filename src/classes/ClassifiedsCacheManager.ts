/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-return */

import axios from 'axios';
import WebSocket from 'ws';
import SKU from '@tf2autobot/tf2-sku';
import Bot from './Bot';
import log from '../lib/logger';

export default class ClassifiedsCacheManager {
    private listingsById = new Map<string, any>();

    private listingsBySku = new Map<string, string[]>();

    private lastSnapshotTimestamp = 0;

    private readonly snapshotCooldown = 5 * 60 * 1000; // 5 minutes

    private ws: WebSocket | null = null;

    private reconnectionAttempts = 0;

    private disconnectTimestamp = 0;

    private needsRefresh = false;

    constructor(private readonly bot: Bot) {}

    async initCache(): Promise<void> {
        const now = Date.now();
        if (now - this.lastSnapshotTimestamp < this.snapshotCooldown) {
            log.debug('Snapshot cache is still fresh, skipping refresh.');
            return;
        }

        log.info('Downloading backpack.tf market snapshot...');
        try {
            const response = await axios.get('https://api.backpack.tf/api/v2/classifieds/listings/snapshot', {
                params: {
                    token: this.bot.options.bptfAccessToken,
                    appid: 440
                }
            });

            if (response.data && response.data.listings) {
                this.listingsById.clear();
                this.listingsBySku.clear();

                for (const listing of response.data.listings) {
                    this.indexListing(listing);
                }

                this.lastSnapshotTimestamp = Date.now();
                this.needsRefresh = false;
                log.info(`Market snapshot loaded: ${this.listingsById.size} listings indexed.`);
            }
        } catch (err) {
            log.error('Failed to download backpack.tf snapshot:', err);
        }
    }

    private indexListing(listing: any): void {
        const id = listing.id;
        const sku = SKU.fromObject(listing.item);

        if (!sku) return;

        this.listingsById.set(id, listing);

        const existing = this.listingsBySku.get(sku) || [];
        if (!existing.includes(id)) {
            existing.push(id);
            this.listingsBySku.set(sku, existing);
        }
    }

    private unindexListing(id: string): void {
        const listing = this.listingsById.get(id);
        if (!listing) return;

        const sku = SKU.fromObject(listing.item);
        this.listingsById.delete(id);

        if (sku) {
            const existing = this.listingsBySku.get(sku);
            if (existing) {
                const index = existing.indexOf(id);
                if (index !== -1) {
                    existing.splice(index, 1);
                    if (existing.length === 0) {
                        this.listingsBySku.delete(sku);
                    } else {
                        this.listingsBySku.set(sku, existing);
                    }
                }
            }
        }
    }

    startStream(): void {
        this.ws = new WebSocket(`wss://ws.backpack.tf/messages?token=${this.bot.options.bptfAccessToken}`);

        this.ws.on('open', () => {
            log.info('Connected to backpack.tf WebSocket stream.');
            this.reconnectionAttempts = 0;
            if (this.needsRefresh || (this.disconnectTimestamp > 0 && Date.now() - this.disconnectTimestamp > 60000)) {
                void this.initCache();
            }
            this.disconnectTimestamp = 0;
        });

        this.ws.on('message', (data: string) => {
            try {
                const payloads = JSON.parse(data);
                if (Array.isArray(payloads)) {
                    for (const payload of payloads) {
                        this.handlePayload(payload);
                    }
                } else {
                    this.handlePayload(payloads);
                }
            } catch (err) {
                log.error('Error parsing backpack.tf WebSocket message:', err);
            }
        });

        this.ws.on('close', () => {
            log.warn('Backpack.tf WebSocket stream closed.');
            this.disconnectTimestamp = Date.now();
            this.reconnect();
        });

        this.ws.on('error', err => {
            log.error('Backpack.tf WebSocket error:', err);
            this.ws?.close();
        });
    }

    private handlePayload(payload: any): void {
        const event = payload.event;
        const data = payload.payload;

        if (event === 'listing_update') {
            this.unindexListing(data.id); // Remove old one if exists
            this.indexListing(data);
            // STEP 3 requirement: Route every verified listing_update to SniperManager
            void this.bot.sniperManager.evaluateListing(data);
        } else if (event === 'listing_delete') {
            this.unindexListing(data.id);
        }
    }

    private reconnect(): void {
        this.reconnectionAttempts++;
        const delay = Math.min(1000 * Math.pow(2, this.reconnectionAttempts), 30000);
        log.info(`Reconnecting to backpack.tf WebSocket in ${delay / 1000}s...`);
        setTimeout(() => this.startStream(), delay);
    }

    getListingsBySku(sku: string, intent?: 0 | 1): any[] {
        const ids = this.listingsBySku.get(sku) || [];
        const listings = ids.map(id => this.listingsById.get(id)).filter(l => !!l);

        if (intent !== undefined) {
            return listings.filter(l => l.intent === intent);
        }
        return listings;
    }
}
