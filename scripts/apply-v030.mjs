import fs from 'node:fs';

function read(path) {
  return fs.readFileSync(path, 'utf8');
}

function write(path, content) {
  fs.writeFileSync(path, content);
}

function replaceOnce(content, search, replacement, label) {
  const next = content.replace(search, replacement);
  if (next === content) {
    throw new Error(`Migration replacement failed: ${label}`);
  }
  return next;
}

const packagePath = 'package.json';
const packageJson = JSON.parse(read(packagePath));
packageJson.version = '0.3.0';
const properties = packageJson.contributes.configuration.properties;
properties['springSupervisor.strictSpringStartGate'] = {
  type: 'boolean',
  default: true,
  description: 'Attempt one graceful stop if Spring Boot Language Server starts before the Java workspace is fully initialized. The stop is issued at most once to avoid restart loops.'
};
properties['springSupervisor.waitForWorkspaceInitialized'] = {
  type: 'boolean',
  default: true,
  description: 'Wait for the Red Hat Java java.workspace.initialized telemetry event, not only serverReady(), before starting Spring Boot Language Server.'
};
properties['springSupervisor.workspaceInitializationTimeoutMs'] = {
  type: 'number',
  default: 180000,
  minimum: 30000,
  maximum: 600000,
  description: 'Fallback timeout while waiting for java.workspace.initialized. Spring startup is allowed after this timeout with a warning.'
};
properties['springSupervisor.maxAutomaticClasspathVerifications'] = {
  type: 'number',
  default: 8,
  minimum: 0,
  maximum: 100,
  description: 'Maximum detected applications for which automatic runtime classpath verification is allowed. Large workspaces skip the expensive JDT requests.'
};
properties['springSupervisor.springRefreshDelayMs'] = {
  type: 'number',
  default: 10000,
  minimum: 1000,
  maximum: 120000,
  description: 'Delay after Spring Boot Language Server startup before the first Beans, Endpoint Mappings, Logical Structure, and Dashboard refresh.'
};
properties['springSupervisor.springSecondRefreshDelayMs'] = {
  type: 'number',
  default: 15000,
  minimum: 0,
  maximum: 120000,
  description: 'Delay after the first Spring refresh before a second recovery refresh. Set to 0 to disable the second pass.'
};
write(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);

let supervisor = read('src/supervisor.ts');
supervisor = replaceOnce(
  supervisor,
  `    private officialRefreshTimer: NodeJS.Timeout | undefined;\n    private strictGateTimer: NodeJS.Timeout | undefined;\n    private strictGateInFlight = false;\n    private springStartAuthorized = false;\n    private lastEarlyStopAt = 0;`,
  `    private officialRefreshTimer: NodeJS.Timeout | undefined;\n    private earlyStopTimer: NodeJS.Timeout | undefined;\n    private workspaceInitializationTimer: NodeJS.Timeout | undefined;\n    private earlyStopAttempted = false;\n    private springStartAuthorized = false;\n    private workspaceInitialized = false;\n    private workspaceInitializationTimedOut = false;`,
  'replace strict gate fields',
);
supervisor = replaceOnce(
  supervisor,
  '        this.startStrictSpringGate(context);',
  '        this.armEarlySpringStop(context);',
  'replace strict gate startup',
);
supervisor = replaceOnce(
  supervisor,
  `        if (this.strictGateTimer) {\n            clearInterval(this.strictGateTimer);\n        }`,
  `        if (this.earlyStopTimer) {\n            clearInterval(this.earlyStopTimer);\n        }\n        if (this.workspaceInitializationTimer) {\n            clearTimeout(this.workspaceInitializationTimer);\n        }`,
  'replace strict gate disposal',
);
supervisor = replaceOnce(
  supervisor,
  "            this.scheduleSettle('Java server ready');",
  `            this.armWorkspaceInitializationFallback();\n            if (this.shouldWaitForWorkspaceInitialized()) {\n                this.setPhase('projects-importing');\n                this.output.appendLine(\n                    '[gate] Java serverReady() completed; waiting for java.workspace.initialized before Spring startup.',\n                );\n            } else {\n                this.scheduleSettle('Java server ready');\n            }`,
  'wait for workspace initialized after serverReady',
);
supervisor = replaceOnce(
  supervisor,
  `            this.disposables.push(api.trackEvent((event) => {\n                const serialized = safeJson(event);`,
  `            this.disposables.push(api.trackEvent((event) => {\n                if (isJavaWorkspaceInitializedEvent(event) && !this.workspaceInitialized) {\n                    this.workspaceInitialized = true;\n                    if (this.workspaceInitializationTimer) {\n                        clearTimeout(this.workspaceInitializationTimer);\n                        this.workspaceInitializationTimer = undefined;\n                    }\n                    this.output.appendLine('[java] Workspace fully initialized (java.workspace.initialized).');\n                    this.scheduleSettle('Java workspace initialized');\n                }\n                const serialized = safeJson(event);`,
  'observe java.workspace.initialized',
);
supervisor = replaceOnce(
  supervisor,
  `    private scheduleSettle(reason: string): void {\n        if (this.settleTimer) {`,
  `    private scheduleSettle(reason: string): void {\n        if (this.shouldWaitForWorkspaceInitialized()\n            && !this.workspaceInitialized\n            && !this.workspaceInitializationTimedOut) {\n            this.output.appendLine(\n                \`[gate] Deferred workspace settlement until java.workspace.initialized: \${reason}.\`,\n            );\n            return;\n        }\n        if (this.settleTimer) {`,
  'guard scheduleSettle',
);
supervisor = replaceOnce(
  supervisor,
  `            if (!this.javaReady) {\n                this.setPhase('projects-importing');\n                return;\n            }\n\n            this.settledAt = Date.now();\n            this.springStartAuthorized = true;\n            if (this.strictGateTimer) {\n                clearInterval(this.strictGateTimer);\n                this.strictGateTimer = undefined;\n            }`,
  `            if (!this.javaReady) {\n                this.setPhase('projects-importing');\n                return;\n            }\n            if (this.shouldWaitForWorkspaceInitialized()\n                && !this.workspaceInitialized\n                && !this.workspaceInitializationTimedOut) {\n                this.setPhase('projects-importing');\n                this.output.appendLine('[gate] Spring startup remains blocked until Java workspace initialization completes.');\n                return;\n            }\n\n            this.settledAt = Date.now();\n            this.springStartAuthorized = true;\n            if (this.earlyStopTimer) {\n                clearInterval(this.earlyStopTimer);\n                this.earlyStopTimer = undefined;\n            }`,
  'guard afterWorkspaceSettled',
);
supervisor = replaceOnce(
  supervisor,
  /    private startStrictSpringGate\(context: vscode\.ExtensionContext\): void \{[\s\S]*?\n    private scheduleOfficialRefresh\(\): void \{/,
  `    private armEarlySpringStop(context: vscode.ExtensionContext): void {\n        const enabled = vscode.workspace.getConfiguration('springSupervisor')\n            .get<boolean>('strictSpringStartGate', true);\n        if (!enabled) {\n            this.output.appendLine('[spring-gate] One-shot early Spring stop is disabled.');\n            return;\n        }\n\n        this.output.appendLine(\n            '[spring-gate] One-shot gate armed; an early Spring LS will be stopped at most once.',\n        );\n        let attemptsRemaining = 120;\n        this.earlyStopTimer = setInterval(() => {\n            if (this.springStartAuthorized || this.workspaceInitialized || this.earlyStopAttempted || attemptsRemaining <= 0) {\n                if (this.earlyStopTimer) {\n                    clearInterval(this.earlyStopTimer);\n                    this.earlyStopTimer = undefined;\n                }\n                return;\n            }\n            attemptsRemaining -= 1;\n            void this.tryStopEarlySpringOnce();\n        }, 500);\n        context.subscriptions.push({ dispose: () => {\n            if (this.earlyStopTimer) {\n                clearInterval(this.earlyStopTimer);\n                this.earlyStopTimer = undefined;\n            }\n        }});\n        void this.tryStopEarlySpringOnce();\n    }\n\n    private async tryStopEarlySpringOnce(): Promise<void> {\n        if (this.springStartAuthorized || this.workspaceInitialized || this.earlyStopAttempted) {\n            return;\n        }\n        const springTools = vscode.extensions.getExtension(SPRING_TOOLS_EXTENSION_ID);\n        if (!springTools?.isActive) {\n            return;\n        }\n        const commands = new Set(await vscode.commands.getCommands(true));\n        if (!commands.has('vscode-spring-boot.ls.stop')) {\n            return;\n        }\n\n        // Mark before awaiting: this command must never be sent repeatedly while the\n        // language client is tearing down its streams.\n        this.earlyStopAttempted = true;\n        try {\n            await vscode.commands.executeCommand('vscode-spring-boot.ls.stop');\n            this.warnings.add(\n                'Spring Boot Tools started before Java workspace initialization; one graceful stop was issued.',\n            );\n            this.output.appendLine('[spring-gate] Issued the one allowed early Spring LS stop.');\n            this.emitHealth();\n        } catch (error) {\n            this.output.appendLine(\`[spring-gate] One-shot early stop failed: \${toErrorMessage(error)}\`);\n        }\n    }\n\n    private shouldWaitForWorkspaceInitialized(): boolean {\n        return vscode.workspace.getConfiguration('springSupervisor')\n            .get<boolean>('waitForWorkspaceInitialized', true);\n    }\n\n    private armWorkspaceInitializationFallback(): void {\n        if (!this.shouldWaitForWorkspaceInitialized() || this.workspaceInitialized || this.workspaceInitializationTimer) {\n            return;\n        }\n        const timeout = vscode.workspace.getConfiguration('springSupervisor')\n            .get<number>('workspaceInitializationTimeoutMs', 180000);\n        this.output.appendLine(\`[gate] Workspace initialization fallback timeout armed for \${timeout}ms.\`);\n        this.workspaceInitializationTimer = setTimeout(() => {\n            this.workspaceInitializationTimer = undefined;\n            if (this.workspaceInitialized) {\n                return;\n            }\n            this.workspaceInitializationTimedOut = true;\n            this.warnings.add(\n                'java.workspace.initialized was not observed before the fallback timeout; Spring startup continued cautiously.',\n            );\n            this.output.appendLine('[gate] Workspace initialization fallback timeout reached.');\n            this.scheduleSettle('workspace initialization fallback timeout');\n        }, timeout);\n    }\n\n    private scheduleOfficialRefresh(): void {`,
  'replace repeated strict gate with one-shot gate',
);
supervisor = replaceOnce(
  supervisor,
  `        const requested = [\n            'spring-boot-dashboard.refresh',\n            'spring.staticData.refresh',\n            'vscode-spring-boot.structure.refresh',\n        ];`,
  `        const requested = [\n            'spring.staticData.refresh',\n            'vscode-spring-boot.structure.refresh',\n            'spring-boot-dashboard.refresh',\n        ];`,
  'refresh static data before views',
);
supervisor = replaceOnce(
  supervisor,
  `        const delay = vscode.workspace.getConfiguration('springSupervisor')\n            .get<number>('springRefreshDelayMs', 5000);\n        this.output.appendLine(\`[spring] Waiting \${delay}ms before refreshing official Spring views.\`);\n        this.officialRefreshTimer = setTimeout(() => {\n            this.officialRefreshTimer = undefined;\n            void this.refreshOfficialDashboard(false);\n        }, delay);`,
  `        const configuration = vscode.workspace.getConfiguration('springSupervisor');\n        const delay = configuration.get<number>('springRefreshDelayMs', 10000);\n        const secondDelay = configuration.get<number>('springSecondRefreshDelayMs', 15000);\n        this.output.appendLine(\`[spring] Waiting \${delay}ms before refreshing official Spring views.\`);\n        this.officialRefreshTimer = setTimeout(() => {\n            this.officialRefreshTimer = undefined;\n            void this.refreshOfficialDashboard(false).finally(() => {\n                if (secondDelay <= 0) {\n                    return;\n                }\n                this.output.appendLine(\`[spring] Scheduling a second recovery refresh in \${secondDelay}ms.\`);\n                this.officialRefreshTimer = setTimeout(() => {\n                    this.officialRefreshTimer = undefined;\n                    void this.refreshOfficialDashboard(false);\n                }, secondDelay);\n            });\n        }, delay);`,
  'add delayed two-pass Spring refresh',
);
supervisor += `\nfunction isJavaWorkspaceInitializedEvent(value: unknown): boolean {\n    if (!value || typeof value !== 'object') {\n        return false;\n    }\n    const name = (value as { readonly name?: unknown }).name;\n    return name === 'java.workspace.initialized';\n}\n`;
write('src/supervisor.ts', supervisor);

let scanner = read('src/scanner.ts');
scanner = replaceOnce(
  scanner,
  `        const verifyClasspath = vscode.workspace.getConfiguration('springSupervisor')\n            .get<boolean>('verifyRuntimeClasspath', false);\n        const getClasspaths = javaApi?.getClasspaths;\n        if (javaReady && verifyClasspath && getClasspaths) {`,
  `        const configuration = vscode.workspace.getConfiguration('springSupervisor');\n        const verifyClasspath = configuration.get<boolean>('verifyRuntimeClasspath', false);\n        const verificationLimit = configuration.get<number>('maxAutomaticClasspathVerifications', 8);\n        const getClasspaths = javaApi?.getClasspaths;\n        if (verifyClasspath && deduplicated.length > verificationLimit) {\n            this.output.appendLine(\n                \`[scanner] Skipped runtime classpath verification for \${deduplicated.length} applications; \`\n                + \`the configured automatic limit is \${verificationLimit}.\`,\n            );\n        }\n        if (javaReady\n            && verifyClasspath\n            && getClasspaths\n            && deduplicated.length <= verificationLimit) {`,
  'limit automatic classpath verification',
);
write('src/scanner.ts', scanner);

let changelog = read('CHANGELOG.md');
changelog = replaceOnce(
  changelog,
  '# Change Log\n\n',
  `# Change Log\n\n## 0.3.0\n\n- Wait for the Java \`java.workspace.initialized\` signal instead of treating \`serverReady()\` as full project readiness.\n- Replace the repeated Spring LS stop loop with a one-shot graceful stop to prevent destroyed-stream restart loops.\n- Skip expensive runtime classpath verification automatically in large workspaces.\n- Refresh Spring static data before the Dashboard and perform a delayed second recovery refresh.\n\n`,
  'prepend changelog',
);
write('CHANGELOG.md', changelog);

console.log('Applied Spring Workspace Supervisor v0.3.0 migration.');
