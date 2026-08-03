import * as vscode from 'vscode';
import type { HealthSnapshot, SpringBootApplication } from './types';

export class HealthTreeProvider implements vscode.TreeDataProvider<HealthTreeItem>, vscode.Disposable {
    private readonly changedEmitter = new vscode.EventEmitter<HealthTreeItem | undefined>();
    private health: HealthSnapshot;

    public readonly onDidChangeTreeData = this.changedEmitter.event;

    public constructor(initialHealth: HealthSnapshot) {
        this.health = initialHealth;
    }

    public update(health: HealthSnapshot): void {
        this.health = health;
        this.changedEmitter.fire(undefined);
    }

    public getTreeItem(element: HealthTreeItem): vscode.TreeItem {
        return element;
    }

    public getChildren(): HealthTreeItem[] {
        const health = this.health;
        return [
            new HealthTreeItem('Supervisor', health.phase, iconForPhase(health.phase)),
            new HealthTreeItem(
                'Java Language Server',
                health.javaReady ? `ready · ${health.javaMode ?? 'unknown mode'}` : health.javaRunning ? 'running · importing' : 'not ready',
                health.javaReady ? 'pass' : health.javaInstalled ? 'loading~spin' : 'error',
            ),
            new HealthTreeItem(
                'Spring Boot Tools',
                health.springToolsActive ? 'active' : health.springToolsInstalled ? 'installed · waiting' : 'not installed',
                health.springToolsActive ? 'pass' : health.springToolsInstalled ? 'clock' : 'warning',
            ),
            new HealthTreeItem(
                'Official Dashboard',
                health.dashboardActive ? 'active' : health.dashboardInstalled ? 'installed' : 'not installed',
                health.dashboardInstalled ? 'dashboard' : 'warning',
            ),
            new HealthTreeItem(
                'Applications',
                `${health.applicationCount} detected · ${health.runningApplicationCount} running`,
                'server-process',
            ),
            new HealthTreeItem(
                'Workspace settled',
                health.settledAt ? new Date(health.settledAt).toLocaleTimeString() : 'not yet',
                health.settledAt ? 'pass' : 'clock',
            ),
            ...(health.lastError
                ? [new HealthTreeItem('Last error', compact(health.lastError), 'error', health.lastError)]
                : []),
            ...health.warnings.map((warning) => new HealthTreeItem('Warning', compact(warning), 'warning', warning)),
        ];
    }

    public dispose(): void {
        this.changedEmitter.dispose();
    }
}

export class ApplicationsTreeProvider implements vscode.TreeDataProvider<ApplicationTreeItem>, vscode.Disposable {
    private readonly changedEmitter = new vscode.EventEmitter<ApplicationTreeItem | undefined>();
    private applications: readonly SpringBootApplication[] = [];

    public readonly onDidChangeTreeData = this.changedEmitter.event;

    public update(applications: readonly SpringBootApplication[]): void {
        this.applications = applications;
        this.changedEmitter.fire(undefined);
    }

    public getTreeItem(element: ApplicationTreeItem): vscode.TreeItem {
        return element;
    }

    public getChildren(): ApplicationTreeItem[] {
        return this.applications.map((application) => new ApplicationTreeItem(application));
    }

    public dispose(): void {
        this.changedEmitter.dispose();
    }
}

export class HealthTreeItem extends vscode.TreeItem {
    public constructor(label: string, description: string, icon: string, tooltip?: string) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.description = description;
        this.iconPath = new vscode.ThemeIcon(icon);
        this.tooltip = tooltip ?? `${label}: ${description}`;
    }
}

export class ApplicationTreeItem extends vscode.TreeItem {
    public constructor(public readonly application: SpringBootApplication) {
        super(application.name, vscode.TreeItemCollapsibleState.None);
        this.description = application.mainClass
            ? `${application.status} · ${shortMainClass(application.mainClass)}`
            : `${application.status} · main class not detected`;
        this.tooltip = new vscode.MarkdownString([
            `**${application.name}**`,
            '',
            `- Status: \`${application.status}\``,
            `- Root: \`${application.projectRoot.fsPath}\``,
            `- Main: ${application.mainClass ? `\`${application.mainClass}\`` : 'not detected'}`,
            `- Classpath verified: ${application.classpathVerified ? 'yes' : 'no'}`,
            `- Detected by: ${application.detectedBy.join(', ')}`,
        ].join('\n'));
        this.iconPath = new vscode.ThemeIcon(iconForApplication(application));
        this.contextValue = contextForApplication(application);
        this.command = {
            command: application.mainFile ? 'springSupervisor.openMainClass' : 'springSupervisor.openBuildFile',
            title: application.mainFile ? 'Open Main Class' : 'Open Build File',
            arguments: [this],
        };
        this.resourceUri = application.projectRoot;
    }
}

function contextForApplication(application: SpringBootApplication): string {
    if (application.status === 'running') {
        return 'springSupervisor.app.running';
    }
    if (application.mainClass && application.status === 'ready') {
        return 'springSupervisor.app.ready';
    }
    return 'springSupervisor.app.project';
}

function iconForApplication(application: SpringBootApplication): string {
    if (application.status === 'running') {
        return 'debug-start';
    }
    if (application.status === 'error') {
        return 'error';
    }
    if (application.status === 'importing') {
        return 'loading~spin';
    }
    return application.mainClass ? 'server-process' : 'project';
}

function iconForPhase(phase: HealthSnapshot['phase']): string {
    switch (phase) {
        case 'healthy':
            return 'pass';
        case 'error':
            return 'error';
        case 'degraded':
            return 'warning';
        case 'java-activating':
        case 'projects-importing':
        case 'classpath-settling':
        case 'spring-starting':
        case 'discovering':
            return 'loading~spin';
        default:
            return 'pulse';
    }
}

function shortMainClass(mainClass: string): string {
    const segments = mainClass.split('.');
    return segments.at(-1) ?? mainClass;
}

function compact(value: string): string {
    return value.replace(/\s+/g, ' ').slice(0, 120);
}
