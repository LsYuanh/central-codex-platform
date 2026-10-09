// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial
// Applies only audited edits to the pinned, clean Codex source tree.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const pin = JSON.parse(readFileSync(join(here, 'upstream.json'), 'utf8'));
const root = resolve(process.argv[2] ?? join(here, `.cache/codex-${pin.commit}`));
const condition = 'std::env::var("CODEX_REMOTE_WORKSPACE").as_deref() == Ok("1")';
const coreCondition = 'crate::remote_workspace::enabled()';
const edits = new Map();
const replace = (path, before, after) => {
  const item = edits.get(path) ?? { original: readFileSync(join(root, path), 'utf8') };
  item.text ??= item.original;
  if (item.text.split(before).length !== 2) throw new Error(`Expected exactly one anchor in ${path}: ${before.slice(0, 100)}`);
  item.text = item.text.replace(before, after);
  edits.set(path, item);
};
const at = (path, anchor, addition) => replace('codex-rs/' + path, anchor, anchor + '\n' + addition);
// Upstream release automation updated workspace.version but left local lock entries at 0.0.0.
// Normalize only packages without a registry/git source; dependency versions/checksums stay pinned.
{
  const path = 'codex-rs/Cargo.lock';
  const original = readFileSync(join(root, path), 'utf8');
  const text = original.replace(/(\[\[package\]\]\nname = "[^"]+"\nversion = ")0\.0\.0("\n)(?!source =)/g, (_, before, after) => before + pin.version + after);
  edits.set(path, { original, text });
}
at('core/src/lib.rs', 'pub mod config;', 'pub mod remote_workspace;');
at('core/src/tools/registry.rs', 'pub(crate) trait CoreToolRuntime: ToolExecutor<ToolInvocation> {', '    /// Only the audited external device-tool runtime may opt into remote dispatch.\n    fn remote_workspace_safe(&self) -> bool { false }');
replace('codex-rs/core/src/tools/handlers/dynamic.rs', 'impl CoreToolRuntime for DynamicToolHandler {}', `impl CoreToolRuntime for DynamicToolHandler {
    fn remote_workspace_safe(&self) -> bool {
        self.tool_name.is_default_namespace() && crate::remote_workspace::device_tool(&self.tool_name.name)
    }
}`);
at('core/src/tools/registry.rs', '        let telemetry_tags = tool.telemetry_tags(&invocation);', `        if ${coreCondition} && !tool.remote_workspace_safe() {
            return Err(FunctionCallError::RespondToModel("REMOTE_WORKSPACE_UNSUPPORTED: local or unadapted tool".into()));
        }
        if ${coreCondition} && invocation.turn.collaboration_mode().mode == codex_protocol::config_types::ModeKind::Plan {
            let name = tool.tool_name();
            if !name.is_default_namespace() || !(crate::remote_workspace::plan_tool(&name.name) || matches!(name.name.as_str(), "update_plan" | "request_user_input" | "get_goal")) {
                return Err(FunctionCallError::RespondToModel("PLAN_MODE_READ_ONLY: confirm the plan and switch to default mode before executing changes or commands".into()));
            }
        }`);
for (const [path, runtime] of [['plan', 'PlanHandler'], ['request_user_input', 'RequestUserInputHandler']]) {
    at('core/src/tools/handlers/' + path + '.rs', 'impl CoreToolRuntime for ' + runtime + ' {', '    fn remote_workspace_safe(&self) -> bool { true }');
}
at('core/src/tools/handlers/extension_tools.rs', 'impl CoreToolRuntime for ExtensionToolAdapter {', `    fn remote_workspace_safe(&self) -> bool {
        let name = self.0.tool_name();
        (name.is_default_namespace() && matches!(name.name.as_str(), "get_goal" | "create_goal" | "update_goal"))
            || (crate::remote_workspace::image_generation_enabled() && name.namespace.as_deref() == Some("image_gen") && name.name == "imagegen")
    }`);
at('core/src/tools/spec_plan.rs', ') -> CodexResult<ToolRouter> {\n    let default_agent_type_description =', '');
// The fast path exposes only audited control extensions and client-device tools.
replace('codex-rs/core/src/tools/spec_plan.rs', ') -> CodexResult<ToolRouter> {\n    let default_agent_type_description =\n', `) -> CodexResult<ToolRouter> {
    if ${coreCondition} {
        let mut registry = ToolRegistry::default();
        registry.add(PlanHandler);
        registry.add_with_exposure(RequestUserInputHandler { available_modes: vec![codex_protocol::config_types::ModeKind::Plan, codex_protocol::config_types::ModeKind::Default] }, ToolExposure::DirectModelOnly);
        for executor in extension_tool_executors(session, step_store) {
            let name = executor.tool_name();
            if (name.is_default_namespace() && matches!(name.name.as_str(), "get_goal" | "create_goal" | "update_goal"))
                || (crate::remote_workspace::image_generation_enabled() && name.namespace.as_deref() == Some("image_gen") && name.name == "imagegen") {
                registry.register_external(Arc::new(ExtensionToolAdapter::new(executor)));
            }
        }
        append_dynamic_tool_runtimes(&turn_context.dynamic_tools, &mut registry);
        let denied: Vec<_> = registry.entries().filter(|tool| !tool.runtime.remote_workspace_safe()).map(|tool| tool.runtime.tool_name()).collect();
        for name in denied { registry.remove(&name); }
        let specs = registry.entries().map(|tool| tool.runtime.spec()).collect();
        return Ok(ToolRouter::from_parts(registry, specs, ToolMode::Direct, BTreeMap::new(), None, &[]));
    }
    let default_agent_type_description =`);
at('features/src/lib.rs', '    pub fn enabled(&self, f: Feature) -> bool {', `        if ${condition} { return matches!(f, Feature::Goals); }`);
at('core/src/agents_md.rs', '    let mut loaded = LoadedAgentsMd::from_user_instructions(user_instructions);', `    if ${coreCondition} { return Ok((!loaded.is_empty()).then_some(loaded)); }`);
// 0.156 moved global instructions into codex-home and refreshes them each turn.
at('codex-home/src/instructions/mod.rs', '    async fn load_from_codex_home(&self) -> LoadedUserInstructions {', `        if ${condition} { return LoadedUserInstructions::default(); }`);
at('core/src/thread_manager.rs', '    ) -> CodexResult<NewThread> {\n        let fork_source = self.get_thread(forked_from_thread_id).await?;', '');
replace('codex-rs/core/src/thread_manager.rs', '    ) -> CodexResult<NewThread> {\n        let fork_source = self.get_thread(forked_from_thread_id).await?;\n', `    ) -> CodexResult<NewThread> {
        if ${coreCondition} { return Err(CodexErr::InvalidRequest("REMOTE_WORKSPACE_UNSUPPORTED: subagent".into())); }
        let fork_source = self.get_thread(forked_from_thread_id).await?;`);
at('core/src/thread_manager.rs', '    ) -> CodexResult<NewThread> {\n        if !matches!(options.session_source, Some(SessionSource::Internal(_))) {', '');
replace('codex-rs/core/src/thread_manager.rs', '    ) -> CodexResult<NewThread> {\n        if !matches!(options.session_source, Some(SessionSource::Internal(_))) {\n', `    ) -> CodexResult<NewThread> {
        if ${coreCondition} { return Err(CodexErr::InvalidRequest("REMOTE_WORKSPACE_UNSUPPORTED: internal subagent".into())); }
        if !matches!(options.session_source, Some(SessionSource::Internal(_))) {`);
at('core/src/exec_policy.rs', 'pub async fn load_exec_policy(config_stack: &ConfigLayerStack) -> Result<Policy, ExecPolicyError> {', `    if ${coreCondition} { return Ok(PolicyParser::new().build()); }`);
at('config/src/loader/mod.rs', ') -> io::Result<ConfigLayerStack> {', `    let cwd = if ${condition} { None } else { cwd };`);
at('core/src/config/mod.rs', '        Box::pin(async move {\n        if cfg.experimental_thread_store_endpoint.is_some() {', '');
replace('codex-rs/core/src/config/mod.rs', '        Box::pin(async move {\n        if cfg.experimental_thread_store_endpoint.is_some() {\n', `        Box::pin(async move {
        if ${coreCondition} {
            cfg.notify = None;
            cfg.model_instructions_file = None;
            cfg.mcp_servers.clear();
        }
        if cfg.experimental_thread_store_endpoint.is_some() {`);
replace('codex-rs/core/src/config/mod.rs', '        let agent_roles =\n            load_agent_roles(fs, &cfg, &config_layer_stack, &mut startup_warnings).await?;', `        let agent_roles = if ${coreCondition} { Default::default() } else {
            load_agent_roles(fs, &cfg, &config_layer_stack, &mut startup_warnings).await?
        };`);
at('core/src/config/mod.rs', '        let mut harness_overrides = harness_overrides.unwrap_or_default();', `        if ${coreCondition} { harness_overrides.cwd = Some(std::env::current_dir()?); }`);
at('core/src/session/mod.rs', ') -> HooksConfig {', `    if ${coreCondition} { return HooksConfig::default(); }`);
at('core/src/session/session.rs', ') -> Vec<SkillError> {', `    if ${coreCondition} { return Vec::new(); }`);
replace('codex-rs/core/src/session/session.rs', '            let default_shell = if let Some(user_shell_override) =', `            let default_shell = if ${coreCondition} {
                shell::Shell { shell_type: shell::ShellType::Bash, shell_path: std::path::PathBuf::from("/bin/false") }
            } else if let Some(user_shell_override) =`);
at('core/src/context/world_state/environment.rs', '    ) -> Self {\n        let shell_version =', '');
replace('codex-rs/core/src/context/world_state/environment.rs', '    ) -> Self {\n        let shell_version =\n', `    ) -> Self {
        if ${coreCondition} { return Self::default(); }
        let shell_version =`);
at('codex-mcp/src/connection_manager.rs', '    ) -> Self {\n        let trusted_access = TrustedAccessContext::from_runtime(&input);', '');
replace('codex-rs/codex-mcp/src/connection_manager.rs', '    ) -> Self {\n        let trusted_access = TrustedAccessContext::from_runtime(&input);\n', `    ) -> Self {
        if ${condition} { return Self::empty(input.config.prefix_mcp_tool_names); }
        let trusted_access = TrustedAccessContext::from_runtime(&input);`);
at('core-plugins/src/manager.rs', '    pub async fn plugins_for_config(&self, config: &PluginsConfigInput) -> PluginLoadOutcome {', `        if ${condition} { return PluginLoadOutcome::default(); }`);
at('ext/skills/src/host_service.rs', '    ) -> HostSkillsSnapshot {\n        let roots = self.skill_roots_for_config(input, fs).await;', '');
replace('codex-rs/ext/skills/src/host_service.rs', '    ) -> HostSkillsSnapshot {\n        let roots = self.skill_roots_for_config(input, fs).await;\n', `    ) -> HostSkillsSnapshot {
        if ${condition} { return self.managed_snapshot(input).await; }
        let roots = self.skill_roots_for_config(input, fs).await;`);
at('ext/skills/src/host_service.rs', 'impl HostSkillsService {', readFileSync(join(here, 'managed-skills-host.rs.inc'), 'utf8'));
at('ext/skills/src/host_service.rs', '    fn ensure_system_skills_installed(&self) {', `        if ${condition} { return; }`);
at('ext/skills/src/host_service.rs', '    ) -> Vec<AbsolutePathBuf> {', `        if ${condition} { return Vec::new(); }`);
at('ext/skills/src/host_service.rs', '    ) -> HostSkillsSnapshot {\n        let bundled_skills_enabled =', '');
replace('codex-rs/ext/skills/src/host_service.rs', '    ) -> HostSkillsSnapshot {\n        let bundled_skills_enabled =\n', `    ) -> HostSkillsSnapshot {
        if ${condition} { return self.managed_snapshot(input).await; }
        let bundled_skills_enabled =`);
at('exec-server/src/environment.rs', '    ) -> Result<PreparedEnvironmentManager, ExecServerError> {', `        if ${condition} {
            return Ok(PreparedEnvironmentManager { source: PreparedEnvironmentSource::Snapshot(DefaultEnvironmentProvider::new(Some("none".into())).snapshot_inner()) });
        }`);
at('exec-server/src/environment.rs', '    pub async fn prepare_from_env() -> Result<PreparedEnvironmentManager, ExecServerError> {', `        if ${condition} {
            return Ok(PreparedEnvironmentManager { source: PreparedEnvironmentSource::Snapshot(DefaultEnvironmentProvider::new(Some("none".into())).snapshot_inner()) });
        }`);
at('git-utils/src/info.rs', 'pub fn get_git_repo_root(base_dir: &Path) -> Option<PathBuf> {', `    if ${condition} { return None; }`);
at('git-utils/src/info.rs', 'pub async fn collect_git_info(cwd: &Path) -> Option<GitInfo> {', `    if ${condition} { return None; }`);
at('git-utils/src/info.rs', 'fn find_ancestor_git_entry(base_dir: &Path) -> Option<(PathBuf, PathBuf)> {', `    if ${condition} { return None; }`);
at('git-utils/src/git_process.rs', 'fn spawn_git_command(command: &mut Command) -> Option<(Child, KillGitProcessTreeOnDrop)> {', `    if ${condition} { return None; }`);
at('app-server/src/extensions.rs', '        builder.turn_start_admission(admission);\n    }', `    if codex_core::remote_workspace::enabled() {
        if codex_core::remote_workspace::image_generation_enabled() {
            // The extension emits inline bytes; client persistence belongs to Local Agent.
            codex_image_generation_extension::install(&mut builder, auth_manager.clone(), |_| None);
        }
        if let Some(state_db) = state_db {
            codex_goal_extension::install_with_backend(
                &mut builder, state_db, analytics_events_client, codex_otel::global(),
                thread_manager.clone(), goal_service,
                |config: &Config| GoalExtensionConfig {
                    enabled: config.features.enabled(codex_features::Feature::Goals),
                    max_goal_token_budget: config.max_goal_token_budget,
                },
            );
        }
        let providers = codex_skills_extension::SkillProviders::new().with_host_provider(Arc::new(codex_skills_extension::HostSkillProvider::new()));
        codex_skills_extension::install_with_providers_and_metrics(&mut builder, providers, codex_otel::global(), |config: &Config| codex_skills_extension::SkillsExtensionConfig {
            include_instructions: config.include_skill_instructions, max_context_tokens: config.skill_max_context_tokens, bundled_skills_enabled: false, orchestrator_skills_enabled: false, shadow_selection_enabled: false,
        });
        return Arc::new(builder.build());
    }`);
at('app-server/src/lib.rs', '    runtime_options: AppServerRuntimeOptions,\n) -> IoResult<AppServerExit> {', `    let mut runtime_options = runtime_options;
    if codex_core::remote_workspace::enabled() {
        runtime_options.plugin_startup_tasks = PluginStartupTasks::Skip;
        runtime_options.remote_control_startup_mode = RemoteControlStartupMode::DisabledEphemeral;
    }`);
at('app-server/src/message_processor.rs', '        outbound_initialized: Option<&AtomicBool>,\n        request_context: RequestContext,\n    ) -> Result<(), JSONRPCErrorError> {\n        let connection_id = connection_request_id.connection_id;', `        if codex_core::remote_workspace::enabled() {
            let value = serde_json::to_value(&codex_request).map_err(|e| JSONRPCErrorError { code: -32602, message: e.to_string(), data: None })?;
            codex_core::remote_workspace::validate_request(&value).map_err(|message| JSONRPCErrorError { code: -32602, message, data: None })?;
        }`);
replace('codex-rs/app-server/src/request_processors/initialize_processor.rs', '        let user_agent = get_codex_user_agent();', `        let user_agent = if codex_core::remote_workspace::enabled() {
            format!("{} {}{}", get_codex_user_agent(), codex_core::remote_workspace::MARKER,
                if codex_core::remote_workspace::image_generation_enabled() { " yuan-zhou-image-generation/1" } else { "" })
        } else { get_codex_user_agent() };`);

// The Mac broker supplies the official catalog without giving Workers login tokens.
// Remote image calls use the same credential authority, never a host executor.
at('ext/image-generation/src/extension.rs', '            available: config.model_provider.is_openai()', '                || (codex_core::remote_workspace::image_generation_enabled() && config.model_provider_id == "yuan_broker")');
at('ext/image-generation/src/tool.rs', '    let paths = args.referenced_image_paths.as_deref().unwrap_or_default();', `    if codex_core::remote_workspace::enabled() && !paths.is_empty() {
        return Err(FunctionCallError::RespondToModel("REMOTE_IMAGE_PATH_DENIED: attach client images through Local Agent and use num_last_images_to_include".into()));
    }`);
at('ext/image-generation/src/tool.rs', ') -> Option<AbsolutePathBuf> {\n    let (output_dir, save_result) = match save_root {', '');
replace('codex-rs/ext/image-generation/src/tool.rs', ') -> Option<AbsolutePathBuf> {\n    let (output_dir, save_result) = match save_root {\n', `) -> Option<AbsolutePathBuf> {
    // Both LOCAL_FS and executor fallback are forbidden for remote image output.
    if codex_core::remote_workspace::enabled() { return None; }
    let (output_dir, save_result) = match save_root {
`);
const catalogEnabled = 'std::env::var("CODEX_REMOTE_WORKSPACE").as_deref() == Ok("1") && std::env::var("CODEX_REMOTE_AUTH_MODE").as_deref() == Ok("broker") && std::env::var("CODEX_REMOTE_MODEL_CATALOG").as_deref() == Ok("1")';
at('models-manager/src/manager.rs', '    async fn should_refresh_models(&self) -> bool {', `        if ${catalogEnabled} { return true; }`);
replace('codex-rs/models-manager/src/manager.rs', 'presets = ModelPreset::filter_by_auth(presets, uses_codex_backend);', `presets = ModelPreset::filter_by_auth(presets, uses_codex_backend || (${catalogEnabled}));`);
// The broker token is not an OpenAI API key; retain the Codex catalog wire format.
replace('codex-rs/models-manager/src/manager.rs', '        if self.uses_api_key_auth()\n', `        if !(${catalogEnabled}) && self.uses_api_key_auth()\n`);
replace('codex-rs/models-manager/src/manager.rs', '&& (self.supports_api_key_discovery()\n', `&& ((${catalogEnabled}) || self.supports_api_key_discovery()\n`);

const baseDir = join(here, '.cache/patch-base');
const expectedFiles = new Map(JSON.parse(readFileSync(join(here, 'source-files.json'), 'utf8')).map(item => [item.path, item.upstreamSha256]));
for (const [path, item] of edits) {
  if (createHash('sha256').update(item.original).digest('hex') !== expectedFiles.get(path)) {
    throw new Error(`Pinned upstream hash mismatch: ${path}; refusing to patch`);
  }
}
mkdirSync(baseDir, { recursive: true });
let patch = '';
const files = [];
for (const [path, item] of edits) {
  const originalPath = join(baseDir, path);
  mkdirSync(dirname(originalPath), { recursive: true });
  writeFileSync(originalPath, item.original);
  writeFileSync(join(root, path), item.text);
  if (path.endsWith('.rs')) {
    const fmt = spawnSync(process.env.RUSTFMT ?? 'rustfmt', ['--edition', '2024', '--config', 'skip_children=true', join(root, path)], { encoding: 'utf8' });
    if (fmt.status !== 0) throw new Error(`rustfmt failed for ${path}: ${fmt.stderr}`);
  }
  // Keep the startup guard anchored to runtime options, not the unrelated auth type
  // renamed in 0.159. Full-file hashes still protect pinned source preparation.
  const context = path === 'codex-rs/app-server/src/lib.rs' ? ['--unified=2'] : [];
  const diff = spawnSync('git', ['diff', '--no-index', '--no-prefix', ...context, '--', originalPath, join(root, path)], { encoding: 'utf8' });
  if (![0, 1].includes(diff.status)) throw new Error(diff.stderr);
  const lines = diff.stdout.split('\n');
  patch += lines.map(line => line.startsWith('diff --git ') ? `diff --git a/${path} b/${path}` : line.startsWith('--- ') ? `--- a/${path}` : line.startsWith('+++ ') ? `+++ b/${path}` : line).join('\n');
  files.push({ path, upstreamSha256: createHash('sha256').update(item.original).digest('hex'),
    patchedSha256: createHash('sha256').update(readFileSync(join(root, path), 'utf8').replace(/\r\n/g, '\n')).digest('hex') });
}
const moduleText = readFileSync(join(here, 'remote_workspace.rs'), 'utf8').replace(/\r\n/g, '\n');
writeFileSync(join(root, 'codex-rs/core/src/remote_workspace.rs'), moduleText);
const moduleLines = moduleText.trimEnd().split('\n');
patch += `diff --git a/codex-rs/core/src/remote_workspace.rs b/codex-rs/core/src/remote_workspace.rs\nnew file mode 100644\n--- /dev/null\n+++ b/codex-rs/core/src/remote_workspace.rs\n@@ -0,0 +1,${moduleLines.length} @@\n` + moduleLines.map(line => '+' + line).join('\n') + '\n';
writeFileSync(join(here, 'remote-workspace.patch'), patch);
writeFileSync(join(here, 'source-files.json'), JSON.stringify(files, null, 2) + '\n');
console.log(`Applied ${files.length + 1} files; generated remote-workspace.patch`);
