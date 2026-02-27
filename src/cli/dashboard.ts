import readline from 'readline';
import { PairManager } from '../monitor/pair_manager.js';

export class CLI {
    private managers: PairManager[];
    private activeManager: PairManager | null = null;
    private isMenuMode: boolean = true;
    private renderedLines: number = 0;

    // UI Navigation State
    private cursorIndex: number = 0;
    private readonly PAGE_SIZE: number = 15;

    constructor(managers: PairManager[]) {
        this.managers = managers;
        this.setupKeyboardListeners();
    }

    public showMenu() {
        this.isMenuMode = true;
        this.activeManager = null;
        this.renderMenu();
    }

    private renderMenu() {
        if (!this.isMenuMode) return;

        console.clear();
        console.log(`\n=== ARBITRAGER MASTER CONTROL (${this.managers.length} Pairs) ===`);
        console.log(`Use UP/DOWN arrows to navigate. Press ENTER to monitor. Press 'q' to exit.\n`);

        // Calculate pagination window
        const pageStart = Math.floor(this.cursorIndex / this.PAGE_SIZE) * this.PAGE_SIZE;
        const pageEnd = Math.min(pageStart + this.PAGE_SIZE, this.managers.length);

        for (let i = pageStart; i < pageEnd; i++) {
            const manager = this.managers[i];
            const title = manager.pairData.polyMarket.market_question.substring(0, 65) + "...";
            const alignment = manager.pairData.outcomeAlignment === -1 ? "[FLIPPED]" : "[ALIGNED]";

            if (i === this.cursorIndex) {
                console.log(`  > \x1b[36m[${i}] ${alignment} ${title}\x1b[0m`); // Cyan highlight
            } else {
                console.log(`    [${i}] ${alignment} ${title}`);
            }
        }

        console.log(`\nShowing ${pageStart + 1}-${pageEnd} of ${this.managers.length}`);
    }

    private setupKeyboardListeners() {
        readline.emitKeypressEvents(process.stdin);
        if (process.stdin.isTTY) {
            process.stdin.setRawMode(true);
        }

        process.stdin.on('keypress', (str, key) => {
            // Global exit commands
            if ((key.ctrl && key.name === 'c') || key.name === 'q') {
                process.exit();
            }

            if (this.isMenuMode) {
                if (key.name === 'up') {
                    if (this.cursorIndex > 0) this.cursorIndex--;
                    this.renderMenu();
                }
                else if (key.name === 'down') {
                    if (this.cursorIndex < this.managers.length - 1) this.cursorIndex++;
                    this.renderMenu();
                }
                else if (key.name === 'return' || key.name === 'enter') {
                    this.viewManager(this.managers[this.cursorIndex]);
                }
            } else {
                // In Dashboard Mode
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

        manager.attachViewer(() => this.renderDashboard());
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
        output += ` ALIGNMENT: ${this.activeManager.pairData.outcomeAlignment === 1 ? 'ALIGNED (+1)' : 'FLIPPED (-1)'}\n`;
        output += `=============================================================\n`;

        if (!kalshi) {
            output += `\n  Waiting for Kalshi initialization...\n\n`;
        } else {
            output += renderBook('YES OUTCOME', poly.yes, kalshi.yes) + `\n`;
            output += renderBook('NO OUTCOME', poly.no, kalshi.no);
        }

        output += `=============================================================\n`;
        output += ` Press 'b' to return to menu | Press 'q' to exit\n`;

        this.renderedLines = output.split('\n').length - 1;
        process.stdout.write(output);
    }
}