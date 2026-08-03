import fs from 'node:fs';

const packagePath = 'package.json';
const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
if (packageJson.version !== '0.1.0') {
  console.log(`Version is ${packageJson.version}; v0.2.0 migration is not required.`);
  process.exit(0);
}

function replaceRequired(text, before, after, label) {
  if (!text.includes(before)) {
    throw new Error(`Cannot apply ${label}: expected source block was not found.`);
  }
  return text.replace(before, after);
}

let supervisor = fs.readFileSync('src/supervisor.ts', 'utf8');
supervisor = replaceRequired(
  supervisor,
  `    private scanTimer: NodeJS.Timeout | undefined;\n`,
  `    private scanTimer: NodeJS.Timeout | undefined;\n    private officialRefreshTimer: NodeJS.Timeout | undefined;\n    private strictGateTimer: NodeJS.Timeout | undefined;\n    private strictGateInFlight = false;\n    private springStartAuthorized = false;\n    private lastEarlyStopAt = 0;\n    private scanInProgress: Promise<void> | undefined;\n    private pendingScanReason: string | undefined;\n`,
  'supervisor state',
);
supervisor = replaceRequired(
  supervisor,
  `    public async start(context: vscode.ExtensionContext): Promise<void> {\n        this.output.appendLine('[supervisor] Starting Spring Workspace Supervisor.');\n        this.registerWorkspaceWatchers(context);\n        this.registerDebugSessionTracking(context);\n        this.setPhase('discovering');\n        await this.scanNow('initial workspace discovery');\n        void this.bootstrapJava();\n    }\n`,
  `    public async start(context: vscode.ExtensionContext): Promise<void> {\n        this.output.appendLine('[supervisor] Starting Spring Workspace Supervisor.');\n        const springTools = vscode.extensions.getExtension(SPRING_TOOLS_EXTENSION_ID);\n        this.output.appendLine(\`[spring-gate] Spring Boot Tools active at supervisor startup: \${springTools?.isActive ?? false}.\`);\n        this.registerWorkspaceWatchers(context);\n        this.registerDebugSessionTracking(context);\n        this.startStrictSpringGate(context);\n        this.setPhase('discovering');\n\n        // Java readiness and independent application discovery must run concurrently.\n        // A large source scan must never delay registration of Java import listeners.\n        void this.bootstrapJava();\n        void this.scanNow('initial workspace discovery');\n    }\n`,
  'concurrent startup',
);
supervisor = replaceRequired(
  supervisor,
  `        if (this.scanTimer) {\n            clearTimeout(this.scanTimer);\n        }\n        for (const disposable of this.disposables) {\n`,
  `        if (this.scanTimer) {\n            clearTimeout(this.scanTimer);\n        }\n        if (this.officialRefreshTimer) {\n            clearTimeout(this.officialRefreshTimer);\n        }\n        if (this.strictGateTimer) {\n            clearInterval(this.strictGateTimer);\n        }\n        for (const disposable of this.disposables) {\n`,
  'timer disposal',
);
supervisor = replaceRequired(
  supervisor,
  `            this.settledAt = Date.now();\n            this.output.appendLine(\`[gate] Workspace settled after: \${reason}.\`);\n            await this.scanNow('Java workspace settled');\n\n            if (vscode.workspace.getConfiguration('springSupervisor')\n                .get<boolean>('activateSpringToolsAfterJavaReady', true)) {\n                await this.activateSpringTools();\n            }\n            if (vscode.workspace.getConfiguration('springSupervisor')\n                .get<boolean>('refreshOfficialDashboardAfterSettle', true)) {\n                await this.refreshOfficialDashboard(false);\n            }\n\n            this.setPhase(this.lastError ? 'degraded' : 'healthy');\n`,
  `            this.settledAt = Date.now();\n            this.springStartAuthorized = true;\n            if (this.strictGateTimer) {\n                clearInterval(this.strictGateTimer);\n                this.strictGateTimer = undefined;\n            }\n            this.output.appendLine(\`[gate] Workspace settled after: \${reason}.\`);\n\n            // Start Spring tooling before the independent source scan. The old ordering\n            // made Spring wait minutes in large reactors even after Java was ready.\n            if (vscode.workspace.getConfiguration('springSupervisor')\n                .get<boolean>('activateSpringToolsAfterJavaReady', true)) {\n                await this.activateSpringTools();\n            }\n            if (vscode.workspace.getConfiguration('springSupervisor')\n                .get<boolean>('refreshOfficialDashboardAfterSettle', true)) {\n                this.scheduleOfficialRefresh();\n            }\n\n            this.setPhase(this.lastError ? 'degraded' : 'healthy');\n            void this.scanNow('Java workspace settled');\n`,
  'post-settlement ordering',
);
supervisor = replaceRequired(
  supervisor,
  `        this.warnings.delete('Spring Boot Tools is not installed; the supervisor dashboard remains available.');\n        this.setPhase('spring-starting');\n        if (!springTools.isActive) {\n            await springTools.activate();\n            this.output.appendLine('[spring] Activated Spring Boot Tools after Java workspace settlement.');\n        }\n`,
  `        this.warnings.delete('Spring Boot Tools is not installed; the supervisor dashboard remains available.');\n        this.setPhase('spring-starting');\n        if (springTools.isActive) {\n            this.output.appendLine('[spring] Spring Boot Tools was already active when the workspace settled.');\n            this.warnings.add(\n                'Spring Boot Tools activated before the supervisor authorized startup. Another extension or activation event bypassed the gate.',\n            );\n        } else {\n            await springTools.activate();\n            this.output.appendLine('[spring] Activated Spring Boot Tools after Java workspace settlement.');\n        }\n`,
  'early activation diagnosis',
);

const strictGateMethods = `    private startStrictSpringGate(context: vscode.ExtensionContext): void {\n        const enabled = vscode.workspace.getConfiguration('springSupervisor')\n            .get<boolean>('strictSpringStartGate', true);\n        if (!enabled) {\n            this.output.appendLine('[spring-gate] Strict start gate is disabled.');\n            return;\n        }\n\n        this.output.appendLine('[spring-gate] Strict start gate enabled; early Spring LS starts will be stopped until Java settles.');\n        this.strictGateTimer = setInterval(() => {\n            void this.enforceStrictSpringGate();\n        }, 750);\n        context.subscriptions.push({ dispose: () => {\n            if (this.strictGateTimer) {\n                clearInterval(this.strictGateTimer);\n                this.strictGateTimer = undefined;\n            }\n        }});\n        void this.enforceStrictSpringGate();\n    }\n\n    private async enforceStrictSpringGate(): Promise<void> {\n        if (this.springStartAuthorized || this.strictGateInFlight) {\n            return;\n        }\n        const springTools = vscode.extensions.getExtension(SPRING_TOOLS_EXTENSION_ID);\n        if (!springTools?.isActive) {\n            return;\n        }\n        const now = Date.now();\n        if (now - this.lastEarlyStopAt < 2500) {\n            return;\n        }\n\n        const commands = new Set(await vscode.commands.getCommands(true));\n        if (!commands.has('vscode-spring-boot.ls.stop')) {\n            return;\n        }\n\n        this.strictGateInFlight = true;\n        try {\n            await vscode.commands.executeCommand('vscode-spring-boot.ls.stop');\n            this.lastEarlyStopAt = Date.now();\n            this.warnings.add(\n                'Spring Boot Tools attempted to activate before Java settled; the supervisor stopped its language server and will restart it later.',\n            );\n            this.output.appendLine('[spring-gate] Stopped an early Spring Boot Language Server start.');\n            this.emitHealth();\n        } catch (error) {\n            this.output.appendLine(\`[spring-gate] Early stop attempt failed: \${toErrorMessage(error)}\`);\n        } finally {\n            this.strictGateInFlight = false;\n        }\n    }\n\n    private scheduleOfficialRefresh(): void {\n        if (this.officialRefreshTimer) {\n            clearTimeout(this.officialRefreshTimer);\n        }\n        const delay = vscode.workspace.getConfiguration('springSupervisor')\n            .get<number>('springRefreshDelayMs', 5000);\n        this.output.appendLine(\`[spring] Waiting \${delay}ms before refreshing official Spring views.\`);\n        this.officialRefreshTimer = setTimeout(() => {\n            this.officialRefreshTimer = undefined;\n            void this.refreshOfficialDashboard(false);\n        }, delay);\n    }\n\n`;
supervisor = replaceRequired(
  supervisor,
  `    private scheduleScan(reason: string): void {\n`,
  strictGateMethods + `    private scheduleScan(reason: string): void {\n`,
  'strict Spring gate methods',
);

const oldScan = `    private async scanNow(reason: string): Promise<void> {\n        this.output.appendLine(\`[scanner] Scan started: \${reason}.\`);\n        try {\n            const runningIds = new Set(this.sessions.keys());\n            const applications = await this.scanner.scan(this.javaApi, this.javaReady);\n            for (const app of applications) {\n                if (runningIds.has(app.id)) {\n                    app.status = 'running';\n                } else if (!app.mainClass) {\n                    app.status = this.javaReady ? 'discovered' : 'importing';\n                } else {\n                    app.status = this.javaReady ? 'ready' : 'importing';\n                }\n            }\n            this.applications = applications;\n            this.output.appendLine(\`[scanner] Detected \${applications.length} Spring Boot application(s).\`);\n            this.applicationsChangedEmitter.fire(this.applications);\n            this.emitHealth();\n        } catch (error) {\n            this.recordError('Workspace scan failed', error);\n        }\n    }\n`;
const newScan = `    private async scanNow(reason: string): Promise<void> {\n        if (this.scanInProgress) {\n            this.pendingScanReason = reason;\n            this.output.appendLine(\`[scanner] Scan already running; queued: \${reason}.\`);\n            await this.scanInProgress;\n            return;\n        }\n\n        const startedAt = Date.now();\n        const task = (async () => {\n            this.output.appendLine(\`[scanner] Scan started: \${reason}.\`);\n            try {\n                const runningIds = new Set(this.sessions.keys());\n                const applications = await this.scanner.scan(this.javaApi, this.javaReady);\n                for (const app of applications) {\n                    if (runningIds.has(app.id)) {\n                        app.status = 'running';\n                    } else if (!app.mainClass) {\n                        app.status = this.javaReady ? 'discovered' : 'importing';\n                    } else {\n                        app.status = this.javaReady ? 'ready' : 'importing';\n                    }\n                }\n                this.applications = applications;\n                this.output.appendLine(\n                    \`[scanner] Detected \${applications.length} Spring Boot application(s) in \${Date.now() - startedAt}ms.\`,\n                );\n                this.applicationsChangedEmitter.fire(this.applications);\n                this.emitHealth();\n            } catch (error) {\n                this.recordError('Workspace scan failed', error);\n            }\n        })();\n        this.scanInProgress = task;\n        try {\n            await task;\n        } finally {\n            this.scanInProgress = undefined;\n            const pending = this.pendingScanReason;\n            this.pendingScanReason = undefined;\n            if (pending) {\n                void this.scanNow(pending);\n            }\n        }\n    }\n`;
supervisor = replaceRequired(supervisor, oldScan, newScan, 'scan serialization');
fs.writeFileSync('src/supervisor.ts', supervisor);

packageJson.version = '0.2.0';
const properties = packageJson.contributes.configuration.properties;
delete properties['springSupervisor.maxJavaFilesPerProject'];
const reordered = {};
for (const [key, value] of Object.entries(properties)) {
  if (key === 'springSupervisor.activateSpringToolsAfterJavaReady') {
    reordered['springSupervisor.maxMainClassFiles'] = {
      type: 'number', default: 5000, minimum: 100, maximum: 50000,
      description: 'Maximum number of likely Spring Boot main-class source files inspected across the workspace.',
    };
    reordered['springSupervisor.strictSpringStartGate'] = {
      type: 'boolean', default: true,
      description: 'While Java is importing, repeatedly stop an early Spring Boot Language Server start and restart it only after the Java workspace settles.',
    };
  }
  reordered[key] = value;
  if (key === 'springSupervisor.refreshOfficialDashboardAfterSettle') {
    reordered['springSupervisor.springRefreshDelayMs'] = {
      type: 'number', default: 5000, minimum: 0, maximum: 60000,
      description: 'Delay after starting Spring Boot Tools before refreshing official Spring views.',
    };
  }
}
reordered['springSupervisor.verifyRuntimeClasspath'].default = false;
reordered['springSupervisor.verifyRuntimeClasspath'].description = 'Optionally verify each detected application through the Red Hat Java runtime classpath API. Disabled by default because large multi-module workspaces can make these requests slow.';
packageJson.contributes.configuration.properties = reordered;
fs.writeFileSync(packagePath, JSON.stringify(packageJson, null, 2) + '\n');

fs.writeFileSync('CHANGELOG.md', `# Change Log\n\n## 0.2.0\n\n- Added a strict Spring start gate. If Spring Boot Tools is activated while Java is still importing, the supervisor stops its language server and restarts it after the Java workspace settles.\n- Started Java readiness monitoring and application discovery concurrently, so slow source scans no longer delay Java import listeners.\n- Moved Spring Tools startup ahead of the independent application scan after settlement.\n- Replaced per-module source searches with one workspace-wide likely-main-class search.\n- Prevented overlapping scans and added scan duration diagnostics.\n- Added bounded, concurrent, timeout-protected runtime classpath verification; disabled it by default for large workspaces.\n- Added a configurable delay before refreshing official Spring views.\n\n## 0.1.0\n\n- Initial MVP.\n- Java import/classpath quiet-period coordinator.\n- Independent Spring Boot application dashboard.\n- Spring Tools activation and official Dashboard refresh after workspace settlement.\n- Application Run/Debug/Stop actions.\n- Workspace diagnostic report and health view.\n`);

let readme = fs.readFileSync('README.md', 'utf8');
const installMarker = '## What the MVP does';
if (!readme.includes('## Install')) {
  const installSection = [
    '## Install',
    '',
    'Download the latest `.vsix` from the repository Releases page and install it with VS Code\'s **Install from VSIX...** command. Version 0.2.0 is named:',
    '',
    '```text',
    'spring-workspace-supervisor-v0.2.0.vsix',
    '```',
    '',
    'Or run:',
    '',
    '```bash',
    'code --install-extension spring-workspace-supervisor-v0.2.0.vsix',
    '```',
    '',
    '## Version 0.2.0',
    '',
    'This version adds an experimental strict gate that stops Spring Boot Language Server starts before Java settlement, then restarts Spring after the Java quiet period. It also runs Java readiness monitoring concurrently with application discovery and replaces per-module source searches with one workspace-wide scan.',
    '',
    installMarker,
  ].join('\n');
  readme = readme.replace(installMarker, installSection);
}
readme = readme.replace('| `springSupervisor.maxJavaFilesPerProject` | `2000` | Maximum source files scanned per project |', '| `springSupervisor.maxMainClassFiles` | `5000` | Maximum likely main-class files scanned workspace-wide |\n| `springSupervisor.strictSpringStartGate` | `true` | Stop early Spring LS starts until Java settles |');
readme = readme.replace('| `springSupervisor.refreshOfficialDashboardAfterSettle` | `true` | Refresh official Spring views after settling |', '| `springSupervisor.refreshOfficialDashboardAfterSettle` | `true` | Refresh official Spring views after settling |\n| `springSupervisor.springRefreshDelayMs` | `5000` | Delay before refreshing official Spring views |');
readme = readme.replace('| `springSupervisor.verifyRuntimeClasspath` | `true` | Verify Spring dependencies with Java classpath API |', '| `springSupervisor.verifyRuntimeClasspath` | `false` | Optional classpath verification; slower on large workspaces |');
fs.writeFileSync('README.md', readme);

console.log('Applied Spring Workspace Supervisor v0.2.0 migration.');
