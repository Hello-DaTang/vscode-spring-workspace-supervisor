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

interface ParsedMain {
    readonly file: vscode.Uri;
    readonly fullyQualifiedName: string;
}

interface CandidateWithMains {
    readonly candidate: BuildCandidate;
    readonly mains: ParsedMain[];
}

const CLASSPATH_LOOKUP_TIMEOUT_MS = 8000;
const CLASSPATH_LOOKUP_CONCURRENCY = 4;

export class WorkspaceScanner {
    public constructor(private readonly output: vscode.OutputChannel) {}

    public async scan(javaApi: JavaExtensionApi | undefined, javaReady: boolean): Promise<SpringBootApplication[]> {
        const startedAt = Date.now();
        const buildFiles = await vscode.workspace.findFiles(
            '**/{pom.xml,build.gradle,build.gradle.kts}',
            '**/{target,build,node_modules,.git,.gradle,out}/**',
        );

        const candidates = (await Promise.all(buildFiles.map((file) => this.readBuildCandidate(file))))
            .filter((value): value is BuildCandidate => value !== undefined);

        // A single global search is dramatically faster than one findFiles request per module
        // in large Maven reactors. Common Spring Boot launch class suffixes are covered here;
        // Spring build modules without a matching class remain visible as discovered projects.
        const maxMainFiles = vscode.workspace.getConfiguration('springSupervisor')
            .get<number>('maxMainClassFiles', 5000);
        const likelyMainFiles = await vscode.workspace.findFiles(
            '**/src/main/java/**/*{Application,Server,Main}.java',
            '**/{target,build,node_modules,.git,.gradle,out}/**',
            maxMainFiles,
        );
        const parsedMains = (await Promise.all(likelyMainFiles.map((file) => this.readMainClass(file))))
            .filter((value): value is ParsedMain => value !== undefined);

        const grouped = new Map<string, CandidateWithMains>();
        for (const candidate of candidates) {
            grouped.set(candidate.root.toString(), { candidate, mains: [] });
        }
        for (const main of parsedMains) {
            const owner = findOwningCandidate(main.file, candidates);
            if (owner) {
                grouped.get(owner.root.toString())?.mains.push(main);
            }
        }

        const applications: SpringBootApplication[] = [];
        for (const { candidate, mains } of grouped.values()) {
            if (mains.length === 0) {
                if (!candidate.springBuild || (candidate.tool === 'maven' && isAggregatorPom(candidate.text))) {
                    continue;
                }
                applications.push(this.createApplication(candidate, undefined, false, ['build-file']));
                continue;
            }

            for (const main of mains) {
                const detectedBy = ['main-class'];
                if (candidate.springBuild) {
                    detectedBy.push('build-file');
                }
                applications.push(this.createApplication(candidate, main, false, detectedBy));
            }
        }

        const deduplicated = deduplicateApplications(applications)
            .sort((left, right) => left.name.localeCompare(right.name));

        const configuration = vscode.workspace.getConfiguration('springSupervisor');
        const verifyClasspath = configuration.get<boolean>('verifyRuntimeClasspath', false);
        const verificationLimit = configuration.get<number>('maxAutomaticClasspathVerifications', 8);
        const getClasspaths = javaApi?.getClasspaths;
        if (verifyClasspath && deduplicated.length > verificationLimit) {
            this.output.appendLine(
                `[scanner] Skipped runtime classpath verification for ${deduplicated.length} applications; `
                + `the configured automatic limit is ${verificationLimit}.`,
            );
        }
        if (javaReady
            && verifyClasspath
            && getClasspaths
            && deduplicated.length <= verificationLimit) {
            const indexed = deduplicated.map((application, index) => ({ application, index }));
            await runWithConcurrency(indexed, CLASSPATH_LOOKUP_CONCURRENCY, async ({ application, index }) => {
                if (!application.mainFile || !application.mainClass) {
                    return;
                }
                try {
                    const result = await withTimeout(
                        getClasspaths(application.mainFile.toString(), { scope: 'runtime' }),
                        CLASSPATH_LOOKUP_TIMEOUT_MS,
                        `Classpath lookup timed out for ${application.mainClass}`,
                    );
                    const classpathVerified = containsSpringRuntimeClasspath([
                        ...result.classpaths,
                        ...result.modulepaths,
                    ]);
                    deduplicated[index] = {
                        ...application,
                        classpathVerified,
                        detectedBy: classpathVerified && !application.detectedBy.includes('runtime-classpath')
                            ? [...application.detectedBy, 'runtime-classpath']
                            : application.detectedBy,
                    };
                } catch (error) {
                    this.output.appendLine(
                        `[scanner] Classpath lookup failed for ${application.mainClass}: ${toErrorMessage(error)}`,
                    );
                }
            });
        }

        this.output.appendLine(
            `[scanner] Discovery completed in ${Date.now() - startedAt}ms: `
            + `${candidates.length} build file(s), ${parsedMains.length} candidate main class(es).`,
        );
        return deduplicated;
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

    private async readMainClass(file: vscode.Uri): Promise<ParsedMain | undefined> {
        try {
            const bytes = await vscode.workspace.fs.readFile(file);
            const parsed = parseSpringBootMainClass(Buffer.from(bytes).toString('utf8'));
            return parsed ? { file, fullyQualifiedName: parsed.fullyQualifiedName } : undefined;
        } catch (error) {
            this.output.appendLine(`[scanner] Failed to inspect ${file.fsPath}: ${toErrorMessage(error)}`);
            return undefined;
        }
    }

    private createApplication(
        candidate: BuildCandidate,
        main: ParsedMain | undefined,
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

function findOwningCandidate(file: vscode.Uri, candidates: readonly BuildCandidate[]): BuildCandidate | undefined {
    let owner: BuildCandidate | undefined;
    for (const candidate of candidates) {
        const relative = path.relative(candidate.root.fsPath, file.fsPath);
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
            continue;
        }
        if (!owner || candidate.root.fsPath.length > owner.root.fsPath.length) {
            owner = candidate;
        }
    }
    return owner;
}

function deduplicateApplications(applications: readonly SpringBootApplication[]): SpringBootApplication[] {
    const result = new Map<string, SpringBootApplication>();
    for (const application of applications) {
        result.set(application.id, application);
    }
    return [...result.values()];
}

async function runWithConcurrency<T>(
    items: readonly T[],
    concurrency: number,
    worker: (item: T) => Promise<void>,
): Promise<void> {
    let nextIndex = 0;
    const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (nextIndex < items.length) {
            const index = nextIndex;
            nextIndex += 1;
            await worker(items[index]!);
        }
    });
    await Promise.all(runners);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        promise.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (error: unknown) => {
                clearTimeout(timer);
                reject(error instanceof Error ? error : new Error(String(error)));
            },
        );
    });
}

function toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
