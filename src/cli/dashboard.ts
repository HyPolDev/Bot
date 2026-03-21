import readline from 'readline';
import { PairManager } from '../monitor/pair_manager.js';
import { PortfolioManager, Position } from '../portfolio/portfolio_manager.js';
import { Settings } from '../db/models/Settings.js';

enum ViewState {
    HOME,
    ORDERBOOK_LIST,
    ORDERBOOK_LIVE,
    POSITIONS,
    POSITION_LIVE
}

export class CLI {
    private managers: PairManager[];
    private portfolio: PortfolioManager;

    private viewState: ViewState = ViewState.HOME;
    private activeManager: PairManager | null = null;
    private activePosition: Position | null = null;

    private renderedLines: number = 0;
    private cursorIndex: number = 0;
    private positionCursorIndex: number = 0;
    private readonly PAGE_SIZE: number = 15;
    private readonly POSITIONS_PAGE_SIZE: number = 5;

    private refreshInterval: NodeJS.Timeout | null = null;
    private isPaperTrading: boolean = true; // Cached from DB

    constructor(managers: PairManager[], portfolio: PortfolioManager) {
        this.managers = managers;
        this.portfolio = portfolio;

        this.initSettings();
        this.setupKeyboardListeners();

        // Start the UI render loop (updates once per second for static screens)
        this.startRenderLoop();
    }

    private async initSettings() {
        try {
            const settings = await Settings.findOne();
            if (settings) {
                this.isPaperTrading = settings.isPaperTrading;
                if (!this.isPaperTrading) {
                    this.portfolio.relinkRecoveredPositions(this.managers);
                }
            }
        } catch (error) {
            // Fallback gracefully
        }
    }

    public showMenu() {
        this.viewState = ViewState.HOME;
        this.activeManager = null;
        this.renderHome();
    }

    private startRenderLoop() {
        if (this.refreshInterval) clearInterval(this.refreshInterval);
        this.refreshInterval = setInterval(() => {
            if (this.viewState === ViewState.HOME) this.renderHome();
            else if (this.viewState === ViewState.POSITIONS) this.renderPositions();
            // Orderbook live handles its own instant updates via callbacks
        }, 1000);
    }

    // --- KEYBOARD ROUTER ---
    private setupKeyboardListeners() {
        readline.emitKeypressEvents(process.stdin);
        if (process.stdin.isTTY) process.stdin.setRawMode(true);
        process.stdin.resume(); // CRITICAL FIX: Restore stdin stream after bootloader's rl.close() paused it

        process.stdin.on('keypress', (str, key) => {
            if ((key.ctrl && key.name === 'c') || key.name === 'q') {
                console.clear();
                process.exit();
            }

            switch (this.viewState) {
                case ViewState.HOME:
                    if (key.name === '1') {
                        this.viewState = ViewState.ORDERBOOK_LIST;
                        this.renderOrderbookList();
                    } else if (key.name === '2') {
                        this.viewState = ViewState.POSITIONS;
                        this.renderPositions();
                    }
                    break;

                case ViewState.ORDERBOOK_LIST:
                    if (key.name === 'up' && this.cursorIndex > 0) {
                        this.cursorIndex--;
                        this.renderOrderbookList();
                    } else if (key.name === 'down' && this.cursorIndex < this.managers.length - 1) {
                        this.cursorIndex++;
                        this.renderOrderbookList();
                    } else if (key.name === 'return' || key.name === 'enter') {
                        this.viewState = ViewState.ORDERBOOK_LIVE;
                        this.viewManager(this.managers[this.cursorIndex]);
                    } else if (key.name === 'b') {
                        this.viewState = ViewState.HOME;
                        this.renderHome();
                    }
                    break;

                case ViewState.ORDERBOOK_LIVE:
                    if (key.name === 'b') {
                        if (this.activeManager) this.activeManager.detachViewer();
                        this.activeManager = null;
                        this.viewState = ViewState.ORDERBOOK_LIST;
                        this.renderOrderbookList();
                    }
                    break;

                case ViewState.POSITIONS:
                    if (key.name === 'up' && this.positionCursorIndex > 0) {
                        this.positionCursorIndex--;
                        this.renderPositions();
                    } else if (key.name === 'down') {
                        const positions = this.portfolio.getOpenPositions();
                        if (this.positionCursorIndex < positions.length - 1) {
                            this.positionCursorIndex++;
                            this.renderPositions();
                        }
                    } else if (key.name === 'return' || key.name === 'enter') {
                        const positions = this.portfolio.getOpenPositions();
                        if (positions.length > 0) {
                            this.positionCursorIndex = Math.max(0, Math.min(this.positionCursorIndex, positions.length - 1));
                            this.activePosition = positions[this.positionCursorIndex];
                            this.activeManager = this.managers.find(m => m.pairId === this.activePosition!.pairId) || null;
                            this.viewState = ViewState.POSITION_LIVE;
                            this.viewPositionLive();
                        }
                    } else if (key.name === 'b') {
                        this.viewState = ViewState.HOME;
                        this.renderHome();
                    }
                    break;

                case ViewState.POSITION_LIVE:
                    if (key.name === 'b') {
                        if (this.activeManager) this.activeManager.detachViewer();
                        this.activeManager = null;
                        this.activePosition = null;
                        this.viewState = ViewState.POSITIONS;
                        this.renderPositions();
                    }
                    break;
            }
        });
    }

    private clearScreenHelper() {
        if (this.renderedLines > 0) {
            process.stdout.write(`\x1B[${this.renderedLines}A\x1B[J`);
        } else {
            console.clear();
        }
    }

    // --- SCREEN 1: HOME ---
    private renderHome() {
        if (this.viewState !== ViewState.HOME) return;
        this.clearScreenHelper();

        const totalEquity = this.portfolio.getTotalEquity();
        const polyCash = this.portfolio.getPolyCash();
        const kalshiCash = this.portfolio.getKalshiCash();
        const invested = this.portfolio.getInvestedCapital();
        const pnl = this.portfolio.getRealizedPnL();
        const positions = this.portfolio.getOpenPositions().length;

        const modeLabel = this.isPaperTrading
            ? `\x1b[32m[🛡️  PAPER SIMULATION ACTIVE]\x1b[0m`
            : `\x1b[31m[⚠️  LIVE DEPLOYMENT AUTHORIZED ⚠️ ]\x1b[0m`;

        let output = `\n=============================================================\n`;
        output += `                 ARBITRAGE COMMAND CENTER\n`;
        output += `                 ${modeLabel}\n`;
        output += `=============================================================\n\n`;

        output += `  Total Equity      : $${totalEquity.toFixed(2)}\n`;
        output += `  Invested Capital  : $${invested.toFixed(2)}\n`;
        output += `  Realized PnL      : ${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl).toFixed(2)}\n\n`;

        output += `  --- EXCHANGE WALLETS ---\n`;
        output += `  Polymarket Cash   : $${polyCash.toFixed(2)}\n`;
        output += `  Kalshi Cash       : $${kalshiCash.toFixed(2)}\n\n`;

        output += `  Active Positions  : ${positions}\n\n`;

        output += `=============================================================\n`;
        output += `  [1] Market Orderbooks\n`;
        output += `  [2] Active Positions\n`;
        output += `  [q] Quit System\n`;
        output += `=============================================================\n`;

        this.renderedLines = output.split('\n').length - 1;
        process.stdout.write(output);
    }

    // --- SCREEN 2: ACTIVE POSITIONS ---
    private renderPositions() {
        if (this.viewState !== ViewState.POSITIONS) return;
        this.clearScreenHelper();

        const positions = this.portfolio.getOpenPositions();

        if (this.positionCursorIndex >= positions.length) {
            this.positionCursorIndex = Math.max(0, positions.length - 1);
        }

        let output = `\n=============================================================\n`;
        output += `                      ACTIVE POSITIONS (${positions.length})\n`;
        output += `=============================================================\n`;
        output += `Use UP/DOWN arrows to navigate. Press 'b' to go back.\n\n`;

        if (positions.length === 0) {
            output += `  No active trades. Scanning for opportunities...\n\n`;
        } else {
            const pageStart = Math.floor(this.positionCursorIndex / this.POSITIONS_PAGE_SIZE) * this.POSITIONS_PAGE_SIZE;
            const pageEnd = Math.min(pageStart + this.POSITIONS_PAGE_SIZE, positions.length);

            for (let i = pageStart; i < pageEnd; i++) {
                const pos = positions[i];
                if (i === this.positionCursorIndex) {
                    output += `  > \x1b[36m[${i + 1}] ${pos.marketQuestion.substring(0, 50)}...\x1b[0m\n`;
                    output += `    \x1b[36m  Type : ${pos.type}\x1b[0m\n`;
                    output += `    \x1b[36m  Size : ${pos.size} contracts\x1b[0m\n`;
                    output += `    \x1b[36m  Cost : $${pos.totalCost.toFixed(2)} (Poly $${pos.polyCost.toFixed(2)} @ ${pos.polyEntryPrice.toFixed(3)} | Kalshi $${pos.kalshiCost.toFixed(2)} @ ${pos.kalshiEntryPrice.toFixed(3)})\x1b[0m\n\n`;
                } else {
                    output += `    [${i + 1}] ${pos.marketQuestion.substring(0, 50)}...\n`;
                    output += `        Type : ${pos.type}\n`;
                    output += `        Size : ${pos.size} contracts\n`;
                    output += `        Cost : $${pos.totalCost.toFixed(2)} (Poly $${pos.polyCost.toFixed(2)} @ ${pos.polyEntryPrice.toFixed(3)} | Kalshi $${pos.kalshiCost.toFixed(2)} @ ${pos.kalshiEntryPrice.toFixed(3)})\n\n`;
                }
            }
            output += `Showing ${pageStart + 1}-${pageEnd} of ${positions.length}\n`;
        }

        output += `=============================================================\n`;
        output += `  [b] Back to Main Menu\n`;
        output += `=============================================================\n`;

        this.renderedLines = output.split('\n').length - 1;
        process.stdout.write(output);
    }

    // --- SCREEN 3: ORDERBOOK LIST ---
    private renderOrderbookList() {
        if (this.viewState !== ViewState.ORDERBOOK_LIST) return;
        this.clearScreenHelper();

        let output = `\n=== SELECT MARKET TO MONITOR (${this.managers.length} Pairs) ===\n`;
        output += `Use UP/DOWN arrows to navigate. Press ENTER to select. Press 'b' to go back.\n\n`;

        const pageStart = Math.floor(this.cursorIndex / this.PAGE_SIZE) * this.PAGE_SIZE;
        const pageEnd = Math.min(pageStart + this.PAGE_SIZE, this.managers.length);

        for (let i = pageStart; i < pageEnd; i++) {
            const manager = this.managers[i];
            const title = manager.pairData.polyMarket.market_question.substring(0, 65) + "...";
            const alignment = manager.pairData.outcomeAlignment === -1 ? "[FLIPPED]" : "[ALIGNED]";

            if (i === this.cursorIndex) {
                output += `  > \x1b[36m[${i}] ${alignment} ${title}\x1b[0m\n`; // Cyan highlight
            } else {
                output += `    [${i}] ${alignment} ${title}\n`;
            }
        }

        output += `\nShowing ${pageStart + 1}-${pageEnd} of ${this.managers.length}\n`;

        this.renderedLines = output.split('\n').length - 1;
        process.stdout.write(output);
    }

    // --- SCREEN 4: LIVE ORDERBOOK VIEW ---
    private viewManager(manager: PairManager) {
        this.activeManager = manager;
        this.renderedLines = 0;
        console.clear();

        // Attach CLI to manager's instant update loop
        manager.attachViewer(() => {
            if (this.viewState === ViewState.ORDERBOOK_LIVE) this.renderDashboard();
            else if (this.viewState === ViewState.POSITION_LIVE) this.renderPositionLive();
        });
        this.renderDashboard();
    }

    private renderDashboard() {
        if (!this.activeManager || this.viewState !== ViewState.ORDERBOOK_LIVE) return;

        const poly = this.activeManager.latestPolyBook;
        const kalshi = this.activeManager.latestKalshiBook;

        this.clearScreenHelper();

        const formatLevel = (lvl: any) => {
            if (!lvl) return "     ---    ".padEnd(17);
            const price = (lvl.price * 100).toFixed(1) + "¢";
            const size = lvl.size >= 1000 ? (lvl.size / 1000).toFixed(1) + "k" : Math.floor(lvl.size).toString();
            return `${price.padStart(5)} [${size.padStart(6)}]`.padEnd(17);
        };

        const renderBook = (title: string, pBook: any, kBook: any) => {
            let str = `  === ${title} ===\n`;
            str += `  EXCHANGE     |  POLYMARKET        |  KALSHI\n`;
            for (let i = 2; i >= 0; i--) {
                str += `  Ask ${i + 1}        |  ${formatLevel(pBook?.asks[i])} |  ${formatLevel(kBook?.asks[i])}\n`;
            }
            str += `  -------------+--------------------+---------------------\n`;
            for (let i = 0; i < 3; i++) {
                str += `  Bid ${i + 1}        |  ${formatLevel(pBook?.bids[i])} |  ${formatLevel(kBook?.bids[i])}\n`;
            }
            return str;
        };

        let output = `\n=============================================================\n`;
        output += ` MARKET: ${this.activeManager.pairData.polyMarket.market_question}\n`;
        output += ` ALIGNMENT: ${this.activeManager.pairData.outcomeAlignment === 1 ? 'ALIGNED (+1)' : 'FLIPPED (-1)'}\n`;
        output += `=============================================================\n`;

        if (!kalshi) {
            output += `\n  Waiting for Kalshi initialization...\n\n`;
        } else {
            output += renderBook('YES OUTCOME', poly.yes, kalshi.yes) + `\n`;
            output += renderBook('NO OUTCOME', poly.no, kalshi.no);
        }

        output += `=============================================================\n`;
        output += ` Press 'b' to return to list | Press 'q' to exit\n`;

        this.renderedLines = output.split('\n').length - 1;
        process.stdout.write(output);
    }

    private viewPositionLive() {
        if (!this.activePosition || !this.activeManager) return;
        this.renderedLines = 0;
        console.clear();

        this.activeManager.attachViewer(() => {
            if (this.viewState === ViewState.POSITION_LIVE) this.renderPositionLive();
        });
        this.renderPositionLive();
    }

    private renderPositionLive() {
        if (!this.activePosition || !this.activeManager || this.viewState !== ViewState.POSITION_LIVE) return;

        const poly = this.activeManager.latestPolyBook;
        const kalshi = this.activeManager.latestKalshiBook;
        const pos = this.activePosition;

        this.clearScreenHelper();

        const formatLevel = (lvl: any) => {
            if (!lvl) return "     ---    ".padEnd(17);
            const price = (lvl.price * 100).toFixed(1) + "¢";
            const size = lvl.size >= 1000 ? (lvl.size / 1000).toFixed(1) + "k" : Math.floor(lvl.size).toString();
            return `${price.padStart(5)} [${size.padStart(6)}]`.padEnd(17);
        };

        const renderBookDepth2 = (title: string, pBook: any, kBook: any) => {
            let str = `  === ${title} ===\n`;
            str += `  EXCHANGE     |  POLYMARKET        |  KALSHI\n`;
            for (let i = 1; i >= 0; i--) {
                str += `  Ask ${i + 1}        |  ${formatLevel(pBook?.asks[i])} |  ${formatLevel(kBook?.asks[i])}\n`;
            }
            str += `  -------------+--------------------+---------------------\n`;
            for (let i = 0; i < 2; i++) {
                str += `  Bid ${i + 1}        |  ${formatLevel(pBook?.bids[i])} |  ${formatLevel(kBook?.bids[i])}\n`;
            }
            return str;
        };

        const qA = this.activeManager.pairData.polyMarket.market_question;
        const qB = this.activeManager.pairData.kalshiMarket.market_question;
        const rA = this.activeManager.pairData.polyMarket.market_rules;
        const rB = this.activeManager.pairData.kalshiMarket.market_rules;

        // Wrap the rules if they are too long (optional, but probably good to just let terminal wrap or output it raw as requested by "full rules")
        let output = `\n=============================================================\n`;
        output += `  🔵 (Poly)  : ${qA}\n`;
        output += `  🔵 (Rules) : ${rA}\n\n`;
        output += `  🟢 (Kalshi): ${qB}\n`;
        output += `  🟢 (Rules) : ${rB}\n`;
        output += `=============================================================\n`;
        output += `  [ ENTRY DETAILS ]\n`;
        output += `  Type  : ${pos.type}                 Size : ${pos.size} contracts\n`;
        output += `  Cost  : $${pos.totalCost.toFixed(2)}\n`;
        output += `  Basis : Poly $${pos.polyCost.toFixed(2)} @ ${(pos.polyEntryPrice * 100).toFixed(1)}¢ | Kalshi $${pos.kalshiCost.toFixed(2)} @ ${(pos.kalshiEntryPrice * 100).toFixed(1)}¢\n`;
        output += `=============================================================\n`;

        if (!kalshi) {
            output += `\n  Waiting for Kalshi initialization...\n\n`;
        } else {
            output += renderBookDepth2('YES OUTCOME', poly.yes, kalshi.yes) + `\n`;
            output += renderBookDepth2('NO OUTCOME', poly.no, kalshi.no);
        }

        output += `=============================================================\n`;
        output += ` Press 'b' to return to list | Press 'q' to exit\n`;

        this.renderedLines = output.split('\n').length - 1;
        process.stdout.write(output);
    }
}