import * as vscode from 'vscode';

export interface JavaClasspathResult {
    readonly projectRoot: string;
    readonly classpaths: string[];
    readonly modulepaths: string[];
}

export interface JavaExtensionApi {
    readonly apiVersion?: string;
    status?: string;
    serverMode?: string;
    readonly serverRunning?: () => Promise<boolean>;
    readonly serverReady: () => Promise<boolean>;
    readonly getClasspaths?: (
        uri: string,
        options: { readonly scope: 'runtime' | 'test' },
    ) => Promise<JavaClasspathResult>;
    readonly onDidProjectsImport?: vscode.Event<vscode.Uri[]>;
    readonly onDidProjectsDelete?: vscode.Event<vscode.Uri[]>;
    readonly onDidClasspathUpdate?: vscode.Event<vscode.Uri>;
    readonly onDidServerModeChange?: vscode.Event<string>;
    readonly trackEvent?: vscode.Event<unknown>;
}

export interface JavaActivationResult {
    readonly extension: vscode.Extension<JavaExtensionApi>;
    readonly api: JavaExtensionApi;
}

export async function activateJavaExtension(): Promise<JavaActivationResult | undefined> {
    const extension = vscode.extensions.getExtension<JavaExtensionApi>('redhat.java');
    if (!extension) {
        return undefined;
    }

    const api = extension.isActive ? extension.exports : await extension.activate();
    return { extension, api };
}
