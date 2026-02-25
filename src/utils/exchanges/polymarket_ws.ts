import WebSocket from 'ws';

export class PolymarketWS {
    private outcomeIdYes: string;
    private outcomeIdNo: string;
    private isRunning: boolean = false;

    // The callback function passed from PairManager to receive updates
    private onUpdate: (source: string, book: any) => void;

    private polyBooks = {
        yes: { bids: new Map<number, number>(), asks: new Map<number, number>() },
        no: { bids: new Map<number, number>(), asks: new Map<number, number>() }
    };

    constructor(outcomeIdYes: string, outcomeIdNo: string, onUpdate: (source: string, book: any) => void) {
        this.outcomeIdYes = outcomeIdYes;
        this.outcomeIdNo = outcomeIdNo;
        this.onUpdate = onUpdate;
    }

    public start() {
        this.isRunning = true;
        this.connect();
    }

    private connect() {
        if (!this.isRunning) return;

        const ws = new WebSocket('wss://ws-subscriptions-clob.polymarket.com/ws/market');

        ws.on('open', () => {
            const subscribeMsg = {
                assets_ids: [this.outcomeIdYes, this.outcomeIdNo],
                type: "market",
            };
            ws.send(JSON.stringify(subscribeMsg));
        });

        ws.on('message', (data: WebSocket.RawData) => {
            const rawMsg = data.toString();
            if (rawMsg === "PONG") return;

            try {
                const msg = JSON.parse(rawMsg);

                if (msg.event_type === 'book') {
                    const isYes = msg.asset_id === this.outcomeIdYes;
                    const targetMap = isYes ? this.polyBooks.yes : this.polyBooks.no;

                    targetMap.bids.clear();
                    targetMap.asks.clear();

                    msg.bids.forEach((b: any) => targetMap.bids.set(parseFloat(b.price), parseFloat(b.size)));
                    msg.asks.forEach((a: any) => targetMap.asks.set(parseFloat(a.price), parseFloat(a.size)));

                    this.emitUpdate(isYes);
                }
                else if (msg.event_type === 'price_change') {
                    let updatedYes = false;
                    let updatedNo = false;

                    msg.price_changes.forEach((change: any) => {
                        const isYes = change.asset_id === this.outcomeIdYes;
                        const targetMap = isYes ? this.polyBooks.yes : this.polyBooks.no;

                        const price = parseFloat(change.price);
                        const size = parseFloat(change.size);
                        const mapToUpdate = change.side === 'BUY' ? targetMap.bids : targetMap.asks;

                        if (size === 0) {
                            mapToUpdate.delete(price);
                        } else {
                            mapToUpdate.set(price, size);
                        }

                        if (isYes) updatedYes = true;
                        else updatedNo = true;
                    });

                    if (updatedYes) this.emitUpdate(true);
                    if (updatedNo) this.emitUpdate(false);
                }
            } catch (e) {
                console.error("[PolyWS] Failed to parse message:", rawMsg);
            }
        });

        const pingInterval = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) ws.send("PING");
        }, 10000);

        ws.on('close', () => {
            clearInterval(pingInterval);
            setTimeout(() => this.connect(), 500);
        });

        ws.on('error', () => { });
    }

    private emitUpdate(isYes: boolean) {
        const targetMap = isYes ? this.polyBooks.yes : this.polyBooks.no;

        const bids = Array.from(targetMap.bids.entries())
            .map(([price, size]) => ({ price, size }))
            .sort((a, b) => b.price - a.price);

        const asks = Array.from(targetMap.asks.entries())
            .map(([price, size]) => ({ price, size }))
            .sort((a, b) => a.price - b.price);

        // Package the specific side that updated and send it to the orchestrator
        this.onUpdate('Poly[WS]', { isYes, bids, asks });
    }
}