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
packageJson.version = '0.4.1';
packageJson.contributes.configuration.properties['springSupervisor.strictSpringStartGate'].description =
  'Attempt one graceful stop if the official Spring Boot Language Server starts before Java initialization. Automatically bypassed for the Root-Fix backpressure build.';
write(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);

let supervisor = read('src/supervisor.ts');
supervisor = replaceOnce(
  supervisor,
  `    private armEarlySpringStop(context: vscode.ExtensionContext): void {\n        const enabled = vscode.workspace.getConfiguration('springSupervisor')`,
  `    private armEarlySpringStop(context: vscode.ExtensionContext): void {\n        const springTools = vscode.extensions.getExtension(SPRING_TOOLS_EXTENSION_ID);\n        const packageJson = springTools?.packageJSON as {\n            readonly rootFixBuild?: { readonly patch?: unknown };\n        } | undefined;\n        if (packageJson?.rootFixBuild?.patch === 'classpath-listener-backpressure-v2') {\n            this.output.appendLine(\n                '[spring-gate] Root-Fix backpressure build detected; early-stop gate is bypassed.',\n            );\n            return;\n        }\n\n        const enabled = vscode.workspace.getConfiguration('springSupervisor')`,
  'bypass early stop for root-fix v2',
);
supervisor = replaceOnce(
  supervisor,
  `        if (springTools.isActive) {\n            this.output.appendLine('[spring] Spring Boot Tools was already active when the workspace settled.');\n            this.warnings.add(\n                'Spring Boot Tools activated before the supervisor authorized startup. Another extension or activation event bypassed the gate.',\n            );\n        } else {`,
  `        if (springTools.isActive) {\n            const packageJson = springTools.packageJSON as {\n                readonly rootFixBuild?: { readonly patch?: unknown };\n            };\n            if (packageJson.rootFixBuild?.patch === 'classpath-listener-backpressure-v2') {\n                this.output.appendLine(\n                    '[spring] Root-Fix backpressure build is active; preserving its in-flight classpath snapshot.',\n                );\n                this.warnings.delete(\n                    'Spring Boot Tools activated before the supervisor authorized startup. Another extension or activation event bypassed the gate.',\n                );\n            } else {\n                this.output.appendLine('[spring] Spring Boot Tools was already active when the workspace settled.');\n                this.warnings.add(\n                    'Spring Boot Tools activated before the supervisor authorized startup. Another extension or activation event bypassed the gate.',\n                );\n            }\n        } else {`,
  'avoid warning and preserve root-fix registration',
);
write('src/supervisor.ts', supervisor);

let changelog = read('CHANGELOG.md');
changelog = replaceOnce(
  changelog,
  '# Change Log\n\n',
  `# Change Log\n\n## 0.4.1\n\n- Detect the Spring Boot Tools Root-Fix backpressure build through its extension manifest.\n- Bypass the one-shot early-stop gate for that build so its initial JDT classpath snapshot is never cancelled.\n- Preserve an already-active Root-Fix registration without reporting the normal early-activation warning.\n\n`,
  'prepend v0.4.1 changelog',
);
write('CHANGELOG.md', changelog);

console.log('Applied Spring Workspace Supervisor v0.4.1 migration.');
