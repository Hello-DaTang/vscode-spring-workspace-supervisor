import * as vscode from 'vscode';
import { EndpointWorkspaceSymbolProvider } from './endpointSymbols';
import { SpringWorkspaceSupervisor } from './supervisor';
import { SlashAwareWorkspaceSymbolQuickPick } from './symbolQuickPick';
import { ApplicationTreeItem, ApplicationsTreeProvider, HealthTreeProvider } from './tree';
import type { SpringBootApplication } from './types';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const output = vscode.window.createOutputChannel('Spring Workspace Supervisor', { log: true });
    const supervisor = new SpringWorkspaceSupervisor(output);
    const endpointSymbols = new EndpointWorkspaceSymbolProvider(output);
    const symbolQuickPick = new SlashAwareWorkspaceSymbolQuickPick(endpointSymbols, output);
    const healthProvider = new HealthTreeProvider(supervisor.getHealth());
    const applicationsProvider = new ApplicationsTreeProvider();
    const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    statusBar.command = 'springSupervisor.diagnose';
    statusBar.name = 'Spring Workspace Supervisor';
    statusBar.show();

    context.subscriptions.push(
        output,
        supervisor,
        healthProvider,
        applicationsProvider,
        statusBar,
        vscode.languages.registerWorkspaceSymbolProvider(endpointSymbols),
        vscode.window.registerTreeDataProvider('springSupervisor.health', healthProvider),
        vscode.window.registerTreeDataProvider('springSupervisor.apps', applicationsProvider),
        supervisor.onDidChangeHealth((health) => {
            healthProvider.update(health);
            updateStatusBar(statusBar, health.phase, health.applicationCount, health.lastError);
        }),
        supervisor.onDidChangeApplications((applications) => applicationsProvider.update(applications)),
        vscode.commands.registerCommand('springSupervisor.goToSymbolOrEndpoint', () => symbolQuickPick.show()),
        vscode.commands.registerCommand('springSupervisor.refresh', async () => {
            endpointSymbols.clearCache();
            await supervisor.refresh();
        }),
        vscode.commands.registerCommand('springSupervisor.diagnose', () => supervisor.openDiagnosticReport()),
        vscode.commands.registerCommand('springSupervisor.retrySpringIndex', () => supervisor.retrySpringIndex()),
        vscode.commands.registerCommand(
            'springSupervisor.refreshOfficialDashboard',
            async () => {
                endpointSymbols.clearCache();
                await supervisor.refreshOfficialDashboard(true);
            },
        ),
        vscode.commands.registerCommand('springSupervisor.showLog', () => output.show(true)),
        vscode.commands.registerCommand('springSupervisor.runApp', (value: unknown) => {
            const app = resolveApplication(value);
            return app ? supervisor.runApplication(app) : undefined;
        }),
        vscode.commands.registerCommand('springSupervisor.debugApp', (value: unknown) => {
            const app = resolveApplication(value);
            return app ? supervisor.debugApplication(app) : undefined;
        }),
        vscode.commands.registerCommand('springSupervisor.stopApp', (value: unknown) => {
            const app = resolveApplication(value);
            return app ? supervisor.stopApplication(app) : undefined;
        }),
        vscode.commands.registerCommand('springSupervisor.openBuildFile', (value: unknown) => {
            const app = resolveApplication(value);
            return app ? supervisor.openBuildFile(app) : undefined;
        }),
        vscode.commands.registerCommand('springSupervisor.openMainClass', (value: unknown) => {
            const app = resolveApplication(value);
            return app ? supervisor.openMainClass(app) : undefined;
        }),
    );

    applicationsProvider.update(supervisor.getApplications());
    updateStatusBar(statusBar, supervisor.getHealth().phase, 0);
    await supervisor.start(context);
}

export function deactivate(): void {
    // Disposables registered in the extension context own shutdown.
}

function resolveApplication(value: unknown): SpringBootApplication | undefined {
    if (value instanceof ApplicationTreeItem) {
        return value.application;
    }
    if (isApplication(value)) {
        return value;
    }
    void vscode.window.showWarningMessage('No Spring Boot application was selected.');
    return undefined;
}

function isApplication(value: unknown): value is SpringBootApplication {
    return typeof value === 'object'
        && value !== null
        && 'id' in value
        && 'projectRoot' in value
        && 'buildFile' in value;
}

function updateStatusBar(
    statusBar: vscode.StatusBarItem,
    phase: string,
    applicationCount: number,
    lastError?: string,
): void {
    if (lastError) {
        statusBar.text = '$(error) Spring Supervisor';
        statusBar.tooltip = lastError;
        statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        return;
    }
    statusBar.backgroundColor = undefined;
    if (phase === 'healthy') {
        statusBar.text = `$(pass) Spring ${applicationCount}`;
        statusBar.tooltip = `${applicationCount} Spring Boot application(s) detected`;
    } else if (phase === 'degraded') {
        statusBar.text = `$(warning) Spring ${applicationCount}`;
        statusBar.tooltip = 'Spring tooling is partially available; open diagnostics for details.';
    } else {
        statusBar.text = '$(sync~spin) Spring import';
        statusBar.tooltip = `Spring Workspace Supervisor: ${phase}`;
    }
}
