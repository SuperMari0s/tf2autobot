import ReconnectingWebSocket from 'reconnecting-websocket';
import WS from 'ws';
import { EventEmitter } from 'events';
import log from '../lib/logger';
import SKU from '@tf2autobot/tf2-sku';
import Currencies from '@tf2autobot/tf2-currencies';

interface ItemObject {
    defindex: number;
    quality: number;
    craftable?: boolean;
    tradable?: boolean;
    killstreak?: number;
    australium?: boolean;
    effect?: number;
    festive?: boolean;
    paintkit?: number;
    wear?: number;
    quality2?: number;
    craftnumber?: number;
    crateseries?: number;
    target?: number;
    output?: number;
    outputQuality?: number;
    paint?: number;
}

export interface BptfListing {
    id: string;
    steamid: string;
    appid: number;
    price: Currencies;
    intent: number; // 0 for buy, 1 for sell
    item: ItemObject;
    isAutomatic: boolean;
    tradeOfferUrl?: string;
}

interface ListingPayload {
    id: string;
    steamid: string;
    appid: number;
    currencies: {
        keys: number;
        metal: number;
    };
    intent: number;
    item: ItemObject;
    userAgent?: string;
    tradeOfferUrl?: string;
}

interface WsEvent {
    event: string;
    payload: ListingPayload;
}

export default class BptfWebSocket extends EventEmitter {
    private rws: ReconnectingWebSocket;

    constructor() {
        super();
    }

    connect(): void {
        this.rws = new ReconnectingWebSocket('wss://ws.backpack.tf/events', [], {
            WebSocket: WS,
            connectionTimeout: 10000,
            maxRetries: 10
        });

        this.rws.addEventListener('open', () => {
            log.debug('Connected to backpack.tf WebSocket');
        });

        this.rws.addEventListener('message', event => {
            try {
                const data = JSON.parse(event.data as string) as WsEvent | WsEvent[];
                if (Array.isArray(data)) {
                    data.forEach(payload => this.handlePayload(payload));
                } else {
                    this.handlePayload(data);
                }
            } catch (err) {
                const error = err as Error;
                log.error('Error parsing backpack.tf WebSocket message:', error.message);
            }
        });

        this.rws.addEventListener('error', err => {
            log.warn('backpack.tf WebSocket error:', err.message);
        });

        this.rws.addEventListener('close', () => {
            log.debug('Disconnected from backpack.tf WebSocket');
        });
    }

    private handlePayload(payload: WsEvent): void {
        if (payload.event === 'listing-update' || payload.event === 'listing-create') {
            const listing = payload.payload;
            if (listing.appid !== 440) return;

            const bptfListing: BptfListing = {
                id: listing.id,
                steamid: listing.steamid,
                appid: listing.appid,
                price: new Currencies({
                    keys: listing.currencies.keys || 0,
                    metal: listing.currencies.metal || 0
                }),
                intent: listing.intent,
                item: listing.item,
                isAutomatic: listing.userAgent !== undefined,
                tradeOfferUrl: listing.tradeOfferUrl
            };

            const sku = SKU.fromObject(listing.item);
            this.emit('listing', sku, bptfListing);
        }
    }

    disconnect(): void {
        if (this.rws) {
            this.rws.close();
        }
    }
}
