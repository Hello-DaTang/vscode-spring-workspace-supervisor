import fs from 'node:fs';

function read(path) {
  return fs.readFileSync(path, 'utf8');
}

function write(path, content) {
  fs.writeFileSync(path, content);
}

const packagePath = 'package.json';
const packageJson = JSON.parse(read(packagePath));
packageJson.version = '0.4.2';
packageJson.contributes.configuration.properties['springSupervisor.enableSlashEndpointWorkspaceSymbols'].description =
  'Contribute Spring Endpoint Mapping results to VS Code native Ctrl+T workspace-symbol search when the query contains /. This does not replace or rebind Ctrl+T.';
write(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);

const changelogPath = 'CHANGELOG.md';
let changelog = read(changelogPath);
if (!changelog.includes('## 0.4.2')) {
  changelog = changelog.replace(
    '# Change Log\n\n',
    `# Change Log\n\n## 0.4.2\n\n- Keep VS Code's native Ctrl+T command and keybinding unchanged.\n- Activate Spring Boot Tools on demand before requesting Endpoint Mapping workspace symbols.\n- Contribute URL-path results through the standard WorkspaceSymbolProvider only.\n- Add diagnostic output when Spring Boot Tools does not expose an active language client or returns no endpoint symbols.\n\n`
  );
  write(changelogPath, changelog);
}

const readmePath = 'README.md';
let readme = read(readmePath);
if (!readme.includes('## Native Ctrl+T endpoint search')) {
  readme = readme.replace(
    '## Automated releases\n',
    `## Native Ctrl+T endpoint search\n\nVersion 0.4.2 does not replace or rebind Ctrl+T. It registers a standard VS Code Workspace Symbol Provider. When the native Ctrl+T query contains a forward slash, the provider requests Spring Endpoint Mappings and contributes matching results to the normal symbol picker.\n\nExamples:\n\n\`\`\`text\n/admin-api/system/users\nGET /admin-api/system/users\n\`\`\`\n\nIf no results appear, open **Output → Spring Workspace Supervisor** and inspect lines beginning with \`[endpoint-symbols]\`.\n\n## Automated releases\n`
  );
  write(readmePath, readme);
}

console.log('Applied Spring Workspace Supervisor v0.4.2 migration.');
