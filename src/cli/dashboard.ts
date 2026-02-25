import readline from 'readline';
import { PairManager } from '../monitor/pair_manager.js';

export class CLI {
    private managers: PairManager[];
    private activeManager: PairManager | null = null;
    private isMenuMode: boolean = true;
    private renderedLines: number = 0;

    constructor(managers: PairManager[]) {
        this.managers = managers;
        this.setupKeyboardListeners();
    }

    public showMenu() {
        this.isMenuMode = true;
        this.activeManager = null;
        console.clear();
        console.log(`\n=== ARBITRAGER MASTER CONTROL ===`);
        console.log(`Select a market pair to view live orderbooks:\n`);

        this.managers.forEach((manager, index) => {
            // Truncate long questions so they fit on the screen cleanly
            const title = manager.pairData.polyMarket.market_question.substring(0, 70) + "...";
            console.log(`  [${index}] ${title}`);
        });

        console.log(`\nPress the number key of the pair to monitor, or Ctrl+C to exit.`);
    }

    private setupKeyboardListeners() {
        readline.emitKeypressEvents(process.stdin);
        if (process.stdin.isTTY) {
            process.stdin.setRawMode(true);
        }

        process.stdin.on('keypress', (str, key) => {
            if (key.ctrl && key.name === 'c') {
                process.exit();
            }

            if (this.isMenuMode) {
                // If user presses a number, try to load that manager
                const index = parseInt(key.name);
                if (!isNaN(index) && index >= 0 && index < this.managers.length) {
                    this.viewManager(this.managers[index]);
                }
            } else {
                // If in dashboard mode, 'b' goes back to menu
                if (key.name === 'b') {
                    if (this.activeManager) this.activeManager.detachViewer();
                    this.showMenu();
                }
            }
        });
    }

    private viewManager(manager: PairManager) {
        this.isMenuMode = false;
        this.activeManager = manager;
        this.renderedLines = 0;
        console.clear();

        // Attach this CLI to the manager's update loop
        manager.attachViewer(() => this.renderDashboard());

        // Force an immediate render
        this.renderDashboard();
    }

    private renderDashboard() {
        if (!this.activeManager || this.isMenuMode) return;

        const poly = this.activeManager.latestPolyBook;
        const kalshi = this.activeManager.latestKalshiBook;

        if (this.renderedLines > 0) {
            process.stdout.write(`\x1B[${this.renderedLines}A\x1B[J`);
        }

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
        output += ` MARKET: ${this.activeManager.pairData.polyMarket.market_question.substring(0, 50)}...\n`;
        output += `=============================================================\n`;

        if (!kalshi) {
            output += `\n  Waiting for Kalshi initialization...\n\n`;
        } else {
            output += renderBook('YES OUTCOME', poly.yes, kalshi.yes) + `\n`;
            output += renderBook('NO OUTCOME', poly.no, kalshi.no);
        }

        output += `=============================================================\n`;
        output += ` Press 'b' to return to menu | Press Ctrl+C to exit\n`;

        this.renderedLines = output.split('\n').length - 1;
        process.stdout.write(output);
    }
}