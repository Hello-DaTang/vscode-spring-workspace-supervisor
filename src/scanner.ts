import * as path from 'node:path';
import * as vscode from 'vscode';
import {
    containsSpringRuntimeClasspath,
    extractMavenArtifactId,
    isAggregatorPom,
    isSpringBuildText,
    parseSpringBootMainClass,
} from './detection';
import type { JavaExtensionApi } from './javaApi';
import type { BuildTool, SpringBootApplication } from './types';

interface BuildCandidate {
    readonly file: vscode.Uri;
    readonly root: vscode.Uri;
    readonly tool: BuildTool;
    readonly text: string;
    readonly springBuild: boolean;
}

export class WorkspaceScanner {
    public constructor(private readonly output: vscode.OutputChannel) {}

    public async scan(javaApi: JavaExtensionApi | undefined, javaReady: boolean): Promise<SpringBootApplication[]> {
        const buildFiles = await vscode.workspace.findFiles(
            '**/{pom.xml,build.gradle,build.gradle.kts}',
            '**/{target,build,node_modules,.git,.gradle,out}/**',
        );

        const candidates = await Promise.all(buildFiles.map((file) => this.readBuildCandidate(file)));
        const applications: SpringBootApplication[] = [];

        for (const candidate of candidates.filter((value): value is BuildCandidate => value !== undefined)) {
            applications.push(...await this.scanCandidate(candidate, javaApi, javaReady));
        }

        return deduplicateApplications(applications).sort((left, right) => left.name.localeCompare(right.name));
    }

    private async readBuildCandidate(file: vscode.Uri): Promise<BuildCandidate | undefined> {
        try {
            const bytes = await vscode.workspace.fs.readFile(file);
            const text = Buffer.from(bytes).toString('utf8');
            const tool: BuildTool = path.basename(file.fsPath) === 'pom.xml' ? 'maven' : 'gradle';
            return {
                file,
                root: vscode.Uri.file(path.dirname(file.fsPath)),
                tool,
                text,
                springBuild: isSpringBuildText(text),
            };
        } catch (error) {
            this.output.appendLine(`[scanner] Failed to read ${file.fsPath}: ${toErrorMessage(error)}`);
            return undefined;
        }
    }

    private async scanCandidate(
        candidate: BuildCandidate,
        javaApi: JavaExtensionApi | undefined,
        javaReady: boolean,
    ): Promise<SpringBootApplication[]> {
        const maxFiles = vscode.workspace.getConfiguration('springSupervisor')
            .get<number>('maxJavaFilesPerProject', 2000);

        const likelyMainFiles = await vscode.workspace.findFiles(
            new vscode.RelativePattern(candidate.root, 'src/main/java/**/*Application.java'),
            '**/{target,build}/**',
            maxFiles,
        );
        const javaFiles = likelyMainFiles.length > 0
            ? likelyMainFiles
            : await vscode.workspace.findFiles(
                new vscode.RelativePattern(candidate.root, 'src/main/java/**/*.java'),
                '**/{target,build}/**',
                maxFiles,
            );

        const parsedMains: Array<{ readonly file: vscode.Uri; readonly fullyQualifiedName: string }> = [];
        for (const javaFile of javaFiles) {
            try {
                const bytes = await vscode.workspace.fs.readFile(javaFile);
                const parsed = parseSpringBootMainClass(Buffer.from(bytes).toString('utf8'));
                if (parsed) {
                    parsedMains.push({ file: javaFile, fullyQualifiedName: parsed.fullyQualifiedName });
                }
            } catch (error) {
                this.output.appendLine(`[scanner] Failed to inspect ${javaFile.fsPath}: ${toErrorMessage(error)}`);
            }
        }

        if (parsedMains.length === 0) {
            if (!candidate.springBuild || (candidate.tool === 'maven' && isAggregatorPom(candidate.text))) {
                return [];
            }
            return [this.createApplication(candidate, undefined, false, ['build-file'])];
        }

        const applications: SpringBootApplication[] = [];
        for (const main of parsedMains) {
            let classpathVerified = false;
            const detectedBy = ['main-class'];
            if (candidate.springBuild) {
                detectedBy.push('build-file');
            }

            const verifyClasspath = vscode.workspace.getConfiguration('springSupervisor')
                .get<boolean>('verifyRuntimeClasspath', true);
            if (javaReady && verifyClasspath && javaApi?.getClasspaths) {
                try {
                    const result = await javaApi.getClasspaths(main.file.toString(), { scope: 'runtime' });
                    classpathVerified = containsSpringRuntimeClasspath([...result.classpaths, ...result.modulepaths]);
                    if (classpathVerified) {
                        detectedBy.push('runtime-classpath');
                    }
                } catch (error) {
                    this.output.appendLine(
                        `[scanner] Classpath lookup failed for ${main.fullyQualifiedName}: ${toErrorMessage(error)}`,
                    );
                }
            }

            applications.push(this.createApplication(candidate, main, classpathVerified, detectedBy));
        }
        return applications;
    }

    private createApplication(
        candidate: BuildCandidate,
        main: { readonly file: vscode.Uri; readonly fullyQualifiedName: string } | undefined,
        classpathVerified: boolean,
        detectedBy: readonly string[],
    ): SpringBootApplication {
        const projectName = candidate.tool === 'maven'
            ? extractMavenArtifactId(candidate.text) ?? path.basename(candidate.root.fsPath)
            : path.basename(candidate.root.fsPath);
        const name = main && projectName.toLowerCase().endsWith('application')
            ? path.basename(candidate.root.fsPath)
            : projectName;
        const id = `${candidate.root.toString()}::${main?.fullyQualifiedName ?? candidate.file.toString()}`;

        return {
            id,
            name,
            projectRoot: candidate.root,
            buildFile: candidate.file,
            buildTool: candidate.tool,
            mainClass: main?.fullyQualifiedName,
            mainFile: main?.file,
            javaProjectName: projectName,
            classpathVerified,
            detectedBy,
            status: main ? 'ready' : 'discovered',
        };
    }
}

function deduplicateApplications(applications: readonly SpringBootApplication[]): SpringBootApplication[] {
    const result = new Map<string, SpringBootApplication>();
    for (const application of applications) {
        result.set(application.id, application);
    }
    return [...result.values()];
}

function toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
