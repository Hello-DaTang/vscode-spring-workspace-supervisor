import * as vscode from 'vscode';
import { isEndpointPathQuery, matchesEndpointSymbol } from './endpointQuery';

const SPRING_TOOLS_EXTENSION_ID = 'vmware.vscode-spring-boot';
const CACHE_TTL_MS = 30_000;

interface SpringToolsApi {
    readonly client?: {
        sendRequest<T>(method: string, params: unknown): Promise<T>;
    };
}

interface LspPosition {
    readonly line: number;
    readonly character: number;
}

interface LspRange {
    readonly start: LspPosition;
    readonly end: LspPosition;
}

interface LspSymbolInformation {
    readonly name: string;
    readonly kind: number;
    readonly containerName?: string;
    readonly location: {
        readonly uri: string;
        readonly range: LspRange;
    };
}

interface EndpointSymbolCache {
    readonly expiresAt: number;
    readonly symbols: readonly LspSymbolInformation[];
}

export class EndpointWorkspaceSymbolProvider implements vscode.WorkspaceSymbolProvider {
    private cache: EndpointSymbolCache | undefined;
    private requestInFlight: Promise<readonly LspSymbolInformation[]> | undefined;

    public constructor(private readonly output: vscode.OutputChannel) {}

    public async provideWorkspaceSymbols(
        query: string,
        token: vscode.CancellationToken,
    ): Promise<vscode.SymbolInformation[]> {
        const enabled = vscode.workspace.getConfiguration('springSupervisor')
            .get<boolean>('enableSlashEndpointWorkspaceSymbols', true);
        if (!enabled || !isEndpointPathQuery(query) || token.isCancellationRequested) {
            return [];
        }

        try {
            const symbols = await this.loadEndpointSymbols();
            if (token.isCancellationRequested) {
                return [];
            }

            return symbols
                .filter((symbol) => matchesEndpointSymbol(query, symbol.name, symbol.containerName))
                .map((symbol) => toVscodeSymbol(symbol));
        } catch (error) {
            this.output.appendLine(`[endpoint-symbols] Workspace symbol lookup failed: ${toErrorMessage(error)}`);
            return [];
        }
    }

    public clearCache(): void {
        this.cache = undefined;
    }

    private async loadEndpointSymbols(): Promise<readonly LspSymbolInformation[]> {
        const now = Date.now();
        if (this.cache && this.cache.expiresAt > now) {
            return this.cache.symbols;
        }
        if (this.requestInFlight) {
            return this.requestInFlight;
        }

        const extension = vscode.extensions.getExtension<SpringToolsApi>(SPRING_TOOLS_EXTENSION_ID);
        if (!extension?.isActive || !extension.exports?.client) {
            return [];
        }

        this.requestInFlight = extension.exports.client
            .sendRequest<LspSymbolInformation[]>('workspace/symbol', { query: '@/' })
            .then((symbols) => {
                const normalized = Array.isArray(symbols) ? symbols : [];
                this.cache = {
                    expiresAt: Date.now() + CACHE_TTL_MS,
                    symbols: normalized,
                };
                this.output.appendLine(
                    `[endpoint-symbols] Cached ${normalized.length} Spring endpoint mapping symbol(s).`,
                );
                return normalized;
            })
            .finally(() => {
                this.requestInFlight = undefined;
            });

        return this.requestInFlight;
    }
}

function toVscodeSymbol(symbol: LspSymbolInformation): vscode.SymbolInformation {
    const location = new vscode.Location(
        vscode.Uri.parse(symbol.location.uri),
        new vscode.Range(
            symbol.location.range.start.line,
            symbol.location.range.start.character,
            symbol.location.range.end.line,
            symbol.location.range.end.character,
        ),
    );
    return new vscode.SymbolInformation(
        symbol.name,
        toVscodeSymbolKind(symbol.kind),
        symbol.containerName ?? 'Spring Endpoint Mapping',
        location,
    );
}

function toVscodeSymbolKind(lspKind: number): vscode.SymbolKind {
    if (Number.isInteger(lspKind) && lspKind >= 1 && lspKind <= 26) {
        return (lspKind - 1) as vscode.SymbolKind;
    }
    return vscode.SymbolKind.Method;
}

function toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.stack ?? error.message : String(error);
}
