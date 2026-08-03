import * as vscode from 'vscode';
import { isEndpointPathQuery } from './endpointQuery';
import { EndpointWorkspaceSymbolProvider } from './endpointSymbols';

interface SymbolQuickPickItem extends vscode.QuickPickItem {
    readonly location?: vscode.Location;
}

const SEARCH_DEBOUNCE_MS = 180;
const MAX_RESULTS = 500;

export class SlashAwareWorkspaceSymbolQuickPick {
    private requestSequence = 0;

    public constructor(
        private readonly endpointSymbols: EndpointWorkspaceSymbolProvider,
        private readonly output: vscode.OutputChannel,
    ) {}

    public show(): Promise<void> {
        const quickPick = vscode.window.createQuickPick<SymbolQuickPickItem>();
        const disposables = new vscode.DisposableStore();
        let debounceTimer: NodeJS.Timeout | undefined;
        let cancellation: vscode.CancellationTokenSource | undefined;

        quickPick.title = 'Go to Workspace Symbol / Spring Endpoint';
        quickPick.placeholder = 'Type a symbol name, or enter /path to search Spring Endpoint Mappings';
        quickPick.matchOnDescription = true;
        quickPick.matchOnDetail = true;
        quickPick.keepScrollPosition = true;
        quickPick.items = [instructionItem()];

        const scheduleSearch = (query: string): void => {
            if (debounceTimer) {
                clearTimeout(debounceTimer);
            }
            cancellation?.cancel();
            cancellation?.dispose();
            cancellation = new vscode.CancellationTokenSource();
            const request = ++this.requestSequence;
            const token = cancellation.token;

            debounceTimer = setTimeout(() => {
                debounceTimer = undefined;
                void this.updateItems(quickPick, query, request, token);
            }, SEARCH_DEBOUNCE_MS);
        };

        disposables.add(quickPick.onDidChangeValue(scheduleSearch));
        disposables.add(quickPick.onDidAccept(() => {
            const selected = quickPick.selectedItems[0];
            if (!selected?.location) {
                return;
            }
            quickPick.hide();
            void openLocation(selected.location);
        }));

        this.output.appendLine('[symbol-search] Opened slash-aware Ctrl+T picker.');
        quickPick.show();

        return new Promise<void>((resolve) => {
            disposables.add(quickPick.onDidHide(() => {
                if (debounceTimer) {
                    clearTimeout(debounceTimer);
                }
                cancellation?.cancel();
                cancellation?.dispose();
                disposables.dispose();
                quickPick.dispose();
                resolve();
            }));
        });
    }

    private async updateItems(
        quickPick: vscode.QuickPick<SymbolQuickPickItem>,
        rawQuery: string,
        request: number,
        token: vscode.CancellationToken,
    ): Promise<void> {
        const query = rawQuery.trim();
        if (!query) {
            quickPick.busy = false;
            quickPick.items = [instructionItem()];
            return;
        }

        quickPick.busy = true;
        try {
            const symbols = isEndpointPathQuery(query)
                ? await this.endpointSymbols.search(query, token)
                : await executeWorkspaceSymbolSearch(query);

            if (token.isCancellationRequested || request !== this.requestSequence) {
                return;
            }

            const mode = isEndpointPathQuery(query) ? 'endpoint' : 'workspace';
            const items = deduplicate(symbols)
                .slice(0, MAX_RESULTS)
                .map((symbol) => toQuickPickItem(symbol, mode));

            quickPick.items = items.length > 0
                ? items
                : [{
                    label: '$(search-stop) No matching symbols',
                    description: mode === 'endpoint'
                        ? 'Spring Endpoint Mappings returned no matching URL path'
                        : 'No matching workspace symbols',
                    alwaysShow: true,
                }];
            this.output.appendLine(
                `[symbol-search] Loaded ${items.length} ${mode} result(s) for query: ${query}`,
            );
        } catch (error) {
            if (token.isCancellationRequested || request !== this.requestSequence) {
                return;
            }
            const message = toErrorMessage(error);
            quickPick.items = [{
                label: '$(error) Symbol search failed',
                description: message,
                alwaysShow: true,
            }];
            this.output.appendLine(`[symbol-search] Search failed: ${message}`);
        } finally {
            if (request === this.requestSequence) {
                quickPick.busy = false;
            }
        }
    }
}

async function executeWorkspaceSymbolSearch(query: string): Promise<vscode.SymbolInformation[]> {
    const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
        'vscode.executeWorkspaceSymbolProvider',
        query,
    );
    return Array.isArray(symbols) ? symbols : [];
}

function toQuickPickItem(
    symbol: vscode.SymbolInformation,
    mode: 'endpoint' | 'workspace',
): SymbolQuickPickItem {
    const relativePath = vscode.workspace.asRelativePath(symbol.location.uri, false);
    return {
        label: symbol.name,
        description: symbol.containerName || (mode === 'endpoint' ? 'Spring Endpoint Mapping' : undefined),
        detail: relativePath,
        location: symbol.location,
        alwaysShow: mode === 'endpoint',
    };
}

function deduplicate(symbols: readonly vscode.SymbolInformation[]): vscode.SymbolInformation[] {
    const seen = new Set<string>();
    const result: vscode.SymbolInformation[] = [];
    for (const symbol of symbols) {
        const range = symbol.location.range;
        const key = [
            symbol.name,
            symbol.location.uri.toString(),
            range.start.line,
            range.start.character,
        ].join('|');
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        result.push(symbol);
    }
    return result;
}

function instructionItem(): SymbolQuickPickItem {
    return {
        label: '$(symbol-method) Search workspace symbols',
        description: 'Use / in the query to search Spring Endpoint Mappings',
        alwaysShow: true,
    };
}

async function openLocation(location: vscode.Location): Promise<void> {
    const document = await vscode.workspace.openTextDocument(location.uri);
    await vscode.window.showTextDocument(document, {
        preview: true,
        selection: location.range,
    });
}

function toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
