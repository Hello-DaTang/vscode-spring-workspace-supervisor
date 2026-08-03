import * as vscode from 'vscode';

export type BuildTool = 'maven' | 'gradle';

export type ApplicationStatus = 'discovered' | 'importing' | 'ready' | 'running' | 'error';

export type SupervisorPhase =
    | 'idle'
    | 'discovering'
    | 'java-activating'
    | 'java-running'
    | 'projects-importing'
    | 'classpath-settling'
    | 'spring-starting'
    | 'healthy'
    | 'degraded'
    | 'error';

export interface SpringBootApplication {
    readonly id: string;
    readonly name: string;
    readonly projectRoot: vscode.Uri;
    readonly buildFile: vscode.Uri;
    readonly buildTool: BuildTool;
    readonly mainClass?: string;
    readonly mainFile?: vscode.Uri;
    readonly javaProjectName?: string;
    readonly classpathVerified: boolean;
    readonly detectedBy: readonly string[];
    status: ApplicationStatus;
}

export interface HealthSnapshot {
    readonly phase: SupervisorPhase;
    readonly javaInstalled: boolean;
    readonly javaActive: boolean;
    readonly javaStatus?: string;
    readonly javaMode?: string;
    readonly javaRunning: boolean;
    readonly javaReady: boolean;
    readonly springToolsInstalled: boolean;
    readonly springToolsActive: boolean;
    readonly dashboardInstalled: boolean;
    readonly dashboardActive: boolean;
    readonly applicationCount: number;
    readonly runningApplicationCount: number;
    readonly lastImportAt?: number;
    readonly lastClasspathUpdateAt?: number;
    readonly settledAt?: number;
    readonly lastOfficialRefreshAt?: number;
    readonly lastError?: string;
    readonly warnings: readonly string[];
}
