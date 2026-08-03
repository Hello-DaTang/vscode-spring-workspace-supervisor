import fs from 'node:fs';

function read(path) {
  return fs.readFileSync(path, 'utf8');
}

function write(path, content) {
  fs.writeFileSync(path, content);
}

const packagePath = 'package.json';
const packageJson = JSON.parse(read(packagePath));
packageJson.version = '0.5.1';
packageJson.contributes.commands = (packageJson.contributes.commands ?? [])
  .filter((entry) => entry.command !== 'springSupervisor.goToSymbolOrEndpoint');

if (Array.isArray(packageJson.contributes.keybindings)) {
  packageJson.contributes.keybindings = packageJson.contributes.keybindings
    .filter((entry) => entry.command !== 'springSupervisor.goToSymbolOrEndpoint');
  if (packageJson.contributes.keybindings.length === 0) {
    delete packageJson.contributes.keybindings;
  }
}

const properties = packageJson.contributes.configuration.properties;
delete properties['springSupervisor.overrideCtrlT'];
properties['springSupervisor.enableSlashEndpointWorkspaceSymbols'].description =
  'Contribute Spring Endpoint Mapping results to VS Code native Ctrl+T workspace-symbol search when the query contains /. This extension does not replace or rebind Ctrl+T.';
write(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);

const changelogPath = 'CHANGELOG.md';
let changelog = read(changelogPath);
if (!changelog.includes('## 0.5.1')) {
  changelog = changelog.replace(
    '# Change Log\n\n',
    `# Change Log\n\n## 0.5.1\n\n- Remove the temporary custom Ctrl+T command and keybinding introduced by 0.5.0.\n- Restore VS Code's native Ctrl+T behavior without any shortcut override.\n- Keep only the standard WorkspaceSymbolProvider integration for Spring Endpoint Mapping URL queries.\n- Activate Spring Boot Tools on demand before requesting endpoint symbols and emit diagnostic output for empty/unavailable results.\n\n`
  );
  write(changelogPath, changelog);
}

const readmePath = 'README.md';
let readme = read(readmePath);
const nativeSection = `## Native Ctrl+T endpoint search\n\nThe extension does not replace or rebind Ctrl+T. It registers a standard VS Code Workspace Symbol Provider. When the native Ctrl+T query contains a forward slash, the provider requests Spring Endpoint Mappings and contributes matching results to the normal symbol picker.\n\nExamples:\n\n\`\`\`text\n/admin-api/system/users\nGET /admin-api/system/users\n\`\`\`\n\nIf no results appear, open **Output → Spring Workspace Supervisor** and inspect lines beginning with \`[endpoint-symbols]\`.\n\n`;
readme = readme.replace(
  /## Ctrl\+T endpoint search[\s\S]*?(?=## Automated releases)/,
  nativeSection
);
if (!readme.includes('## Native Ctrl+T endpoint search')) {
  readme = readme.replace('## Automated releases\n', `${nativeSection}## Automated releases\n`);
}
write(readmePath, readme);

console.log('Applied Spring Workspace Supervisor v0.5.1 cleanup migration.');
