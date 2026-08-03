import * as vscode from 'vscode';
import { activateJavaExtension, type JavaExtensionApi } from './javaApi';
import { WorkspaceScanner } from './scanner';
import type { HealthSnapshot, SpringBootApplication, SupervisorPhase } from './types';

const SPRING_TOOLS_EXTENSION_ID = 'vmware.vscode-spring-boot';
const DASHBOARD_EXTENSION_ID = 'vscjava.vscode-spring-boot-dashboard';

export class SpringWorkspaceSupervisor implements vscode.Disposable {
    private readonly scanner: WorkspaceScanner;
    private readonly disposables: vscode.Disposable[] = [];
    private readonly applicationsChangedEmitter = new vscode.EventEmitter<readonly SpringBootApplication[]>();
    private readonly healthChangedEmitter = new vscode.EventEmitter<HealthSnapshot>();
    private readonly sessions = new Map<string, vscode.DebugSession>();

    private applications: SpringBootApplication[] = [];
    private javaApi: JavaExtensionApi | undefined;
    private settleTimer: NodeJS.Timeout | undefined;
    private scanTimer: NodeJS.Timeout | undefined;
    private officialRefreshTimer: NodeJS.Timeout | undefined;
    private strictGateTimer: NodeJS.Timeout | undefined;
    private strictGateInFlight = false;
    private springStartAuthorized = false;
    private lastEarlyStopAt = 0;
    private scanInProgress: Promise<void> | undefined;
    private pendingScanReason: string | undefined;
    private phase: SupervisorPhase = 'idle';
    private javaRunning = false;
    private javaReady = false;
    private lastImportAt: number | undefined;
    private lastClasspathUpdateAt: number | undefined;
    private settledAt: number | undefined;
    private lastOfficialRefreshAt: number | undefined;
    private lastError: string | undefined;
    private readonly warnings = new Set<string>();

    public readonly onDidChangeApplications = this.applicationsChangedEmitter.event;
    public readonly onDidChangeHealth = this.healthChangedEmitter.event;

    public constructor(public readonly output: vscode.OutputChannel) {
        this.scanner = new WorkspaceScanner(output);
        this.disposables.push(this.applicationsChangedEmitter, this.healthChangedEmitter);
    }

    public async start(context: vscode.ExtensionContext): Promise<void> {
        this.output.appendLine('[supervisor] Starting Spring Workspace Supervisor.');
        const springTools = vscode.extensions.getExtension(SPRING_TOOLS_EXTENSION_ID);
        this.output.appendLine(`[spring-gate] Spring Boot Tools active at supervisor startup: ${springTools?.isActive ?? false}.`);
        this.registerWorkspaceWatchers(context);
        this.registerDebugSessionTracking(context);
        this.startStrictSpringGate(context);
        this.setPhase('discovering');

        // Java readiness and independent application discovery must run concurrently.
        // A large source scan must never delay registration of Java import listeners.
        void this.bootstrapJava();
        void this.scanNow('initial workspace discovery');
    }

    public getApplications(): readonly SpringBootApplication[] {
        return this.applications;
    }

    public getHealth(): HealthSnapshot {
        const javaExtension = vscode.extensions.getExtension('redhat.java');
        const springTools = vscode.extensions.getExtension(SPRING_TOOLS_EXTENSION_ID);
        const dashboard = vscode.extensions.getExtension(DASHBOARD_EXTENSION_ID);
        return {
            phase: this.phase,
            javaInstalled: javaExtension !== undefined,
            javaActive: javaExtension?.isActive ?? false,
            javaStatus: this.javaApi?.status,
            javaMode: this.javaApi?.serverMode,
            javaRunning: this.javaRunning,
            javaReady: this.javaReady,
            springToolsInstalled: springTools !== undefined,
            springToolsActive: springTools?.isActive ?? false,
            dashboardInstalled: dashboard !== undefined,
            dashboardActive: dashboard?.isActive ?? false,
            applicationCount: this.applications.length,
            runningApplicationCount: this.applications.filter((app) => app.status === 'running').length,
            lastImportAt: this.lastImportAt,
            lastClasspathUpdateAt: this.lastClasspathUpdateAt,
            settledAt: this.settledAt,
            lastOfficialRefreshAt: this.lastOfficialRefreshAt,
            lastError: this.lastError,
            warnings: [...this.warnings],
        };
    }

    public async refresh(): Promise<void> {
        this.clearError();
        this.setPhase(this.javaReady ? 'classpath-settling' : 'discovering');
        await this.scanNow('manual refresh');
        if (this.javaReady) {
            this.scheduleSettle('manual refresh');
        }
    }

    public async retrySpringIndex(): Promise<void> {
        if (!this.javaReady) {
            void vscode.window.showWarningMessage('Java Language Server is not ready yet. The retry will run after import settles.');
            this.scheduleSettle('retry requested while Java is not ready');
            return;
        }
        await this.afterWorkspaceSettled('manual Spring index retry');
    }

    public async refreshOfficialDashboard(showMessage = true): Promise<void> {
        const commands = new Set(await vscode.commands.getCommands(true));
        const requested = [
            'spring-boot-dashboard.refresh',
            'spring.staticData.refresh',
            'vscode-spring-boot.structure.refresh',
        ];
        let executed = 0;
        for (const command of requested) {
            if (!commands.has(command)) {
                continue;
            }
            try {
                await vscode.commands.executeCommand(command);
                executed += 1;
                this.output.appendLine(`[spring] Executed ${command}.`);
            } catch (error) {
                this.output.appendLine(`[spring] ${command} failed: ${toErrorMessage(error)}`);
            }
        }
        this.lastOfficialRefreshAt = Date.now();
        this.emitHealth();
        if (showMessage) {
            void vscode.window.showInformationMessage(
                executed > 0
                    ? `Spring Supervisor refreshed ${executed} official Spring view(s).`
                    : 'No official Spring refresh command is currently available.',
            );
        }
    }

    public async openDiagnosticReport(): Promise<void> {
        const document = await vscode.workspace.openTextDocument({
            language: 'markdown',
            content: this.createDiagnosticReport(),
        });
        await vscode.window.showTextDocument(document, { preview: false });
    }

    public async runApplication(application: SpringBootApplication): Promise<void> {
        await this.launchApplication(application, true);
    }

    public async debugApplication(application: SpringBootApplication): Promise<void> {
        await this.launchApplication(application, false);
    }

    public async stopApplication(application: SpringBootApplication): Promise<void> {
        const session = this.sessions.get(application.id);
        if (!session) {
            void vscode.window.showWarningMessage(`${application.name} is not running in a supervisor-managed debug session.`);
            return;
        }
        await vscode.debug.stopDebugging(session);
    }

    public async openBuildFile(application: SpringBootApplication): Promise<void> {
        await this.openUri(application.buildFile);
    }

    public async openMainClass(application: SpringBootApplication): Promise<void> {
        if (!application.mainFile) {
            void vscode.window.showWarningMessage(`${application.name} does not have a detected @SpringBootApplication class.`);
            return;
        }
        await this.openUri(application.mainFile);
    }

    public dispose(): void {
        if (this.settleTimer) {
            clearTimeout(this.settleTimer);
        }
        if (this.scanTimer) {
            clearTimeout(this.scanTimer);
        }
        if (this.officialRefreshTimer) {
            clearTimeout(this.officialRefreshTimer);
        }
        if (this.strictGateTimer) {
            clearInterval(this.strictGateTimer);
        }
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
    }

    private async bootstrapJava(): Promise<void> {
        this.setPhase('java-activating');
        try {
            const activation = await activateJavaExtension();
            if (!activation) {
                this.warnings.add('Language Support for Java by Red Hat is not installed.');
                this.setPhase('degraded');
                return;
            }
            this.javaApi = activation.api;
            this.registerJavaEvents(activation.api);
            this.emitHealth();

            if (activation.api.serverRunning) {
                const running = await activation.api.serverRunning();
                this.javaRunning = running;
                if (running) {
                    this.setPhase('java-running');
                }
            }

            this.setPhase('projects-importing');
            const ready = await activation.api.serverReady();
            this.javaReady = ready;
            this.javaRunning = this.javaRunning || ready;
            if (!ready) {
                this.warnings.add('The standard Java Language Server did not report ready.');
                this.setPhase('degraded');
                return;
            }

            if (activation.api.serverMode === 'LightWeight') {
                this.warnings.add('Java Language Server is in LightWeight mode; classpath APIs are unavailable.');
            } else {
                this.warnings.delete('Java Language Server is in LightWeight mode; classpath APIs are unavailable.');
            }
            this.scheduleSettle('Java server ready');
        } catch (error) {
            this.recordError('Java extension activation failed', error);
        }
    }

    private registerJavaEvents(api: JavaExtensionApi): void {
        if (api.onDidProjectsImport) {
            this.disposables.push(api.onDidProjectsImport((projects) => {
                this.lastImportAt = Date.now();
                this.output.appendLine(`[java] Imported ${projects.length} project(s).`);
                this.setPhase('projects-importing');
                this.scheduleSettle('project import event');
            }));
        }
        if (api.onDidClasspathUpdate) {
            this.disposables.push(api.onDidClasspathUpdate((project) => {
                this.lastClasspathUpdateAt = Date.now();
                this.output.appendLine(`[java] Classpath updated: ${project.fsPath}`);
                this.scheduleSettle('classpath update event');
            }));
        }
        if (api.onDidProjectsDelete) {
            this.disposables.push(api.onDidProjectsDelete((projects) => {
                this.output.appendLine(`[java] Deleted ${projects.length} project(s).`);
                this.scheduleScan('project deletion event');
            }));
        }
        if (api.onDidServerModeChange) {
            this.disposables.push(api.onDidServerModeChange((mode) => {
                this.output.appendLine(`[java] Server mode changed to ${mode}.`);
                this.scheduleSettle('server mode change');
            }));
        }
        if (api.trackEvent) {
            this.disposables.push(api.trackEvent((event) => {
                const serialized = safeJson(event);
                if (/error|exception|timeout/i.test(serialized)) {
                    this.output.appendLine(`[java-event] ${serialized}`);
                }
            }));
        }
    }

    private registerWorkspaceWatchers(context: vscode.ExtensionContext): void {
        const watcher = vscode.workspace.createFileSystemWatcher(
            '**/{pom.xml,build.gradle,build.gradle.kts,src/main/java/**/*.java}',
        );
        watcher.onDidCreate(() => this.scheduleScan('workspace file created'), this, context.subscriptions);
        watcher.onDidChange(() => this.scheduleScan('workspace file changed'), this, context.subscriptions);
        watcher.onDidDelete(() => this.scheduleScan('workspace file deleted'), this, context.subscriptions);
        context.subscriptions.push(watcher);

        context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration('springSupervisor')) {
                this.scheduleScan('configuration changed');
            }
        }));
    }

    private registerDebugSessionTracking(context: vscode.ExtensionContext): void {
        context.subscriptions.push(vscode.debug.onDidStartDebugSession((session) => {
            const appId = readSupervisorAppId(session.configuration);
            if (!appId) {
                return;
            }
            this.sessions.set(appId, session);
            this.updateApplicationStatus(appId, 'running');
        }));
        context.subscriptions.push(vscode.debug.onDidTerminateDebugSession((session) => {
            const appId = readSupervisorAppId(session.configuration);
            if (!appId) {
                return;
            }
            this.sessions.delete(appId);
            this.updateApplicationStatus(appId, 'ready');
        }));
    }

    private scheduleSettle(reason: string): void {
        if (this.settleTimer) {
            clearTimeout(this.settleTimer);
        }
        const delay = vscode.workspace.getConfiguration('springSupervisor').get<number>('quietPeriodMs', 2500);
        this.setPhase('classpath-settling');
        this.output.appendLine(`[gate] Waiting ${delay}ms for a quiet workspace: ${reason}.`);
        this.settleTimer = setTimeout(() => {
            this.settleTimer = undefined;
            void this.afterWorkspaceSettled(reason);
        }, delay);
    }

    private async afterWorkspaceSettled(reason: string): Promise<void> {
        try {
            if (this.javaApi) {
                this.javaReady = await this.javaApi.serverReady();
            }
            if (!this.javaReady) {
                this.setPhase('projects-importing');
                return;
            }

            this.settledAt = Date.now();
            this.springStartAuthorized = true;
            if (this.strictGateTimer) {
                clearInterval(this.strictGateTimer);
                this.strictGateTimer = undefined;
            }
            this.output.appendLine(`[gate] Workspace settled after: ${reason}.`);

            // Start Spring tooling before the independent source scan. The old ordering
            // made Spring wait minutes in large reactors even after Java was ready.
            if (vscode.workspace.getConfiguration('springSupervisor')
                .get<boolean>('activateSpringToolsAfterJavaReady', true)) {
                await this.activateSpringTools();
            }
            if (vscode.workspace.getConfiguration('springSupervisor')
                .get<boolean>('refreshOfficialDashboardAfterSettle', true)) {
                this.scheduleOfficialRefresh();
            }

            this.setPhase(this.lastError ? 'degraded' : 'healthy');
            void this.scanNow('Java workspace settled');
        } catch (error) {
            this.recordError('Post-import Spring recovery failed', error);
        }
    }

    private async activateSpringTools(): Promise<void> {
        const springTools = vscode.extensions.getExtension(SPRING_TOOLS_EXTENSION_ID);
        if (!springTools) {
            this.warnings.add('Spring Boot Tools is not installed; the supervisor dashboard remains available.');
            this.emitHealth();
            return;
        }
        this.warnings.delete('Spring Boot Tools is not installed; the supervisor dashboard remains available.');
        this.setPhase('spring-starting');
        if (springTools.isActive) {
            this.output.appendLine('[spring] Spring Boot Tools was already active when the workspace settled.');
            this.warnings.add(
                'Spring Boot Tools activated before the supervisor authorized startup. Another extension or activation event bypassed the gate.',
            );
        } else {
            await springTools.activate();
            this.output.appendLine('[spring] Activated Spring Boot Tools after Java workspace settlement.');
        }
        const commands = new Set(await vscode.commands.getCommands(true));
        if (commands.has('vscode-spring-boot.ls.start')) {
            try {
                await vscode.commands.executeCommand('vscode-spring-boot.ls.start');
                this.output.appendLine('[spring] Requested Spring Boot Language Server start.');
            } catch (error) {
                const message = toErrorMessage(error);
                if (!/already|started/i.test(message)) {
                    throw error;
                }
            }
        }
    }

    private startStrictSpringGate(context: vscode.ExtensionContext): void {
        const enabled = vscode.workspace.getConfiguration('springSupervisor')
            .get<boolean>('strictSpringStartGate', true);
        if (!enabled) {
            this.output.appendLine('[spring-gate] Strict start gate is disabled.');
            return;
        }

        this.output.appendLine('[spring-gate] Strict start gate enabled; early Spring LS starts will be stopped until Java settles.');
        this.strictGateTimer = setInterval(() => {
            void this.enforceStrictSpringGate();
        }, 750);
        context.subscriptions.push({ dispose: () => {
            if (this.strictGateTimer) {
                clearInterval(this.strictGateTimer);
                this.strictGateTimer = undefined;
            }
        }});
        void this.enforceStrictSpringGate();
    }

    private async enforceStrictSpringGate(): Promise<void> {
        if (this.springStartAuthorized || this.strictGateInFlight) {
            return;
        }
        const springTools = vscode.extensions.getExtension(SPRING_TOOLS_EXTENSION_ID);
        if (!springTools?.isActive) {
            return;
        }
        const now = Date.now();
        if (now - this.lastEarlyStopAt < 2500) {
            return;
        }

        const commands = new Set(await vscode.commands.getCommands(true));
        if (!commands.has('vscode-spring-boot.ls.stop')) {
            return;
        }

        this.strictGateInFlight = true;
        try {
            await vscode.commands.executeCommand('vscode-spring-boot.ls.stop');
            this.lastEarlyStopAt = Date.now();
            this.warnings.add(
                'Spring Boot Tools attempted to activate before Java settled; the supervisor stopped its language server and will restart it later.',
            );
            this.output.appendLine('[spring-gate] Stopped an early Spring Boot Language Server start.');
            this.emitHealth();
        } catch (error) {
            this.output.appendLine(`[spring-gate] Early stop attempt failed: ${toErrorMessage(error)}`);
        } finally {
            this.strictGateInFlight = false;
        }
    }

    private scheduleOfficialRefresh(): void {
        if (this.officialRefreshTimer) {
            clearTimeout(this.officialRefreshTimer);
        }
        const delay = vscode.workspace.getConfiguration('springSupervisor')
            .get<number>('springRefreshDelayMs', 5000);
        this.output.appendLine(`[spring] Waiting ${delay}ms before refreshing official Spring views.`);
        this.officialRefreshTimer = setTimeout(() => {
            this.officialRefreshTimer = undefined;
            void this.refreshOfficialDashboard(false);
        }, delay);
    }

    private scheduleScan(reason: string): void {
        if (this.scanTimer) {
            clearTimeout(this.scanTimer);
        }
        this.scanTimer = setTimeout(() => {
            this.scanTimer = undefined;
            void this.scanNow(reason);
        }, 500);
    }

    private async scanNow(reason: string): Promise<void> {
        if (this.scanInProgress) {
            this.pendingScanReason = reason;
            this.output.appendLine(`[scanner] Scan already running; queued: ${reason}.`);
            await this.scanInProgress;
            return;
        }

        const startedAt = Date.now();
        const task = (async () => {
            this.output.appendLine(`[scanner] Scan started: ${reason}.`);
            try {
                const runningIds = new Set(this.sessions.keys());
                const applications = await this.scanner.scan(this.javaApi, this.javaReady);
                for (const app of applications) {
                    if (runningIds.has(app.id)) {
                        app.status = 'running';
                    } else if (!app.mainClass) {
                        app.status = this.javaReady ? 'discovered' : 'importing';
                    } else {
                        app.status = this.javaReady ? 'ready' : 'importing';
                    }
                }
                this.applications = applications;
                this.output.appendLine(
                    `[scanner] Detected ${applications.length} Spring Boot application(s) in ${Date.now() - startedAt}ms.`,
                );
                this.applicationsChangedEmitter.fire(this.applications);
                this.emitHealth();
            } catch (error) {
                this.recordError('Workspace scan failed', error);
            }
        })();
        this.scanInProgress = task;
        try {
            await task;
        } finally {
            this.scanInProgress = undefined;
            const pending = this.pendingScanReason;
            this.pendingScanReason = undefined;
            if (pending) {
                void this.scanNow(pending);
            }
        }
    }

    private async launchApplication(application: SpringBootApplication, noDebug: boolean): Promise<void> {
        if (!application.mainClass) {
            void vscode.window.showWarningMessage(`${application.name} has no detected @SpringBootApplication main class.`);
            return;
        }
        const folder = vscode.workspace.getWorkspaceFolder(application.projectRoot);
        const configuration = vscode.workspace.getConfiguration('springSupervisor');
        const profiles = configuration.get<string[]>('defaultProfiles', []);
        const vmArgs = configuration.get<string>('vmArgs', '').trim();
        const args = profiles.length > 0 ? `--spring.profiles.active=${profiles.join(',')}` : undefined;

        const started = await vscode.debug.startDebugging(folder, {
            type: 'java',
            request: 'launch',
            name: `${noDebug ? 'Run' : 'Debug'} ${application.name}`,
            mainClass: application.mainClass,
            projectName: application.javaProjectName,
            cwd: application.projectRoot.fsPath,
            console: 'integratedTerminal',
            noDebug,
            args,
            vmArgs: vmArgs || undefined,
            springSupervisorAppId: application.id,
        });
        if (!started) {
            void vscode.window.showErrorMessage(`VS Code could not start ${application.name}. Open the Java Debug Console for details.`);
        }
    }

    private async openUri(uri: vscode.Uri): Promise<void> {
        const document = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(document, { preview: false });
    }

    private updateApplicationStatus(id: string, status: SpringBootApplication['status']): void {
        const application = this.applications.find((candidate) => candidate.id === id);
        if (!application) {
            return;
        }
        application.status = status;
        this.applicationsChangedEmitter.fire(this.applications);
        this.emitHealth();
    }

    private setPhase(phase: SupervisorPhase): void {
        this.phase = phase;
        this.emitHealth();
    }

    private clearError(): void {
        this.lastError = undefined;
        this.emitHealth();
    }

    private recordError(context: string, error: unknown): void {
        const message = `${context}: ${toErrorMessage(error)}`;
        this.lastError = message;
        this.phase = 'error';
        this.output.appendLine(`[error] ${message}`);
        this.emitHealth();
    }

    private emitHealth(): void {
        this.healthChangedEmitter.fire(this.getHealth());
    }

    private createDiagnosticReport(): string {
        const health = this.getHealth();
        const lines = [
            '# Spring Workspace Supervisor Diagnostic Report',
            '',
            `Generated: ${new Date().toISOString()}`,
            '',
            '## Workspace health',
            '',
            '| Signal | Value |',
            '|---|---|',
            `| Phase | ${health.phase} |`,
            `| Java extension installed / active | ${yesNo(health.javaInstalled)} / ${yesNo(health.javaActive)} |`,
            `| Java status / mode | ${health.javaStatus ?? 'unknown'} / ${health.javaMode ?? 'unknown'} |`,
            `| Java process running / ready | ${yesNo(health.javaRunning)} / ${yesNo(health.javaReady)} |`,
            `| Spring Boot Tools installed / active | ${yesNo(health.springToolsInstalled)} / ${yesNo(health.springToolsActive)} |`,
            `| Official Dashboard installed / active | ${yesNo(health.dashboardInstalled)} / ${yesNo(health.dashboardActive)} |`,
            `| Applications detected / running | ${health.applicationCount} / ${health.runningApplicationCount} |`,
            `| Last project import | ${formatTime(health.lastImportAt)} |`,
            `| Last classpath update | ${formatTime(health.lastClasspathUpdateAt)} |`,
            `| Workspace settled | ${formatTime(health.settledAt)} |`,
            `| Last official refresh | ${formatTime(health.lastOfficialRefreshAt)} |`,
            `| Last error | ${health.lastError ?? 'none'} |`,
            '',
            '## Warnings',
            '',
            ...(health.warnings.length > 0 ? health.warnings.map((warning) => `- ${warning}`) : ['- None']),
            '',
            '## Detected applications',
            '',
            ...this.applications.flatMap((app) => [
                `### ${app.name}`,
                '',
                `- Status: ${app.status}`,
                `- Root: \`${app.projectRoot.fsPath}\``,
                `- Build: ${app.buildTool} — \`${app.buildFile.fsPath}\``,
                `- Main class: ${app.mainClass ? `\`${app.mainClass}\`` : 'not detected'}`,
                `- Runtime classpath verified: ${yesNo(app.classpathVerified)}`,
                `- Detected by: ${app.detectedBy.join(', ')}`,
                '',
            ]),
            '## Relevant commands',
            '',
            '- `Spring Supervisor: Retry Spring Index`',
            '- `Spring Supervisor: Refresh Official Spring Dashboard`',
            '- `Java: Clean Java Language Server Workspace` (manual high-impact recovery)',
            '',
            '> The supervisor can delay its own Spring Tools activation and refresh after Java import settles, but VS Code does not allow one extension to prevent another extension from activating Spring Tools earlier.',
        ];
        return lines.join('\n');
    }
}

function readSupervisorAppId(configuration: vscode.DebugConfiguration): string | undefined {
    const value: unknown = configuration.springSupervisorAppId;
    return typeof value === 'string' ? value : undefined;
}

function toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.stack ?? error.message : String(error);
}

function safeJson(value: unknown): string {
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

function yesNo(value: boolean): string {
    return value ? 'yes' : 'no';
}

function formatTime(value: number | undefined): string {
    return value ? new Date(value).toISOString() : 'never';
}
