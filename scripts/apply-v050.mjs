import fs from 'node:fs';

function read(path) {
  return fs.readFileSync(path, 'utf8');
}

function write(path, content) {
  fs.writeFileSync(path, content);
}

const packagePath = 'package.json';
const packageJson = JSON.parse(read(packagePath));
packageJson.version = '0.5.0';

const commands = packageJson.contributes.commands ?? [];
if (!commands.some((entry) => entry.command === 'springSupervisor.goToSymbolOrEndpoint')) {
  commands.unshift({
    command: 'springSupervisor.goToSymbolOrEndpoint',
    title: 'Go to Workspace Symbol / Spring Endpoint',
    category: 'Spring Supervisor',
    icon: '$(symbol-method)'
  });
}
packageJson.contributes.commands = commands;

const keybindings = packageJson.contributes.keybindings ?? [];
const filteredKeybindings = keybindings.filter(
  (entry) => entry.command !== 'springSupervisor.goToSymbolOrEndpoint'
);
filteredKeybindings.unshift({
  command: 'springSupervisor.goToSymbolOrEndpoint',
  key: 'ctrl+t',
  mac: 'cmd+t',
  when: 'springSupervisor.ctrlTEnabled'
});
packageJson.contributes.keybindings = filteredKeybindings;

const properties = packageJson.contributes.configuration.properties;
properties['springSupervisor.overrideCtrlT'] = {
  type: 'boolean',
  default: true,
  description: 'Replace the native Ctrl+T workspace-symbol picker with a compatible picker that preserves normal symbol search and switches to Spring Endpoint Mapping search when the query contains /. Disable this setting to restore the native Ctrl+T binding.'
};
properties['springSupervisor.enableSlashEndpointWorkspaceSymbols'].description =
  'Expose Spring Endpoint Mapping results to workspace-symbol consumers and the slash-aware Ctrl+T picker when a query contains /.';

write(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);

const changelogPath = 'CHANGELOG.md';
let changelog = read(changelogPath);
if (!changelog.includes('## 0.5.0')) {
  changelog = changelog.replace(
    '# Change Log\n\n',
    `# Change Log\n\n## 0.5.0\n\n- Replace the native Ctrl+T picker with a compatible workspace-symbol picker that supports URL paths containing forward slashes.\n- Preserve ordinary class, method, and workspace-symbol search when the query does not contain a slash.\n- Query Spring Boot Language Server directly with @/ for Endpoint Mappings and bypass VS Code's second fuzzy-filter pass for URL results.\n- Add springSupervisor.overrideCtrlT so the custom binding can be disabled and the native Ctrl+T restored.\n\n`
  );
  write(changelogPath, changelog);
}

const readmePath = 'README.md';
let readme = read(readmePath);
if (!readme.includes('## Ctrl+T endpoint search')) {
  readme = readme.replace(
    '## Automated releases\n',
    `## Ctrl+T endpoint search\n\nVersion 0.5.0 replaces the native Ctrl+T workspace-symbol picker with a compatible picker. Normal text continues to search ordinary workspace symbols. As soon as the query contains a forward slash, the picker searches Spring Endpoint Mappings instead.\n\nExamples:\n\n\`\`\`text\n/admin-api/system/users\nGET /admin-api/system/users\n\`\`\`\n\nSet \`springSupervisor.overrideCtrlT\` to \`false\` to restore VS Code's native Ctrl+T binding. The command remains available as **Spring Supervisor: Go to Workspace Symbol / Spring Endpoint**.\n\n## Automated releases\n`
  );
  write(readmePath, readme);
}

console.log('Applied Spring Workspace Supervisor v0.5.0 manifest migration.');
