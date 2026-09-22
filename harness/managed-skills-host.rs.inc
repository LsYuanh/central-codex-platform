    // Platform-owned projections contain only SKILL.md and invocation metadata.
    // They never contain executable scripts or business files. Read a fresh
    // catalog for every turn: disabled/deleted skills cannot survive a cache hit.
    async fn managed_snapshot(&self, input: &HostSkillsLoadInput) -> HostSkillsSnapshot {
        let empty = || HostSkillsSnapshot::new(Arc::new(Default::default()));
        let Ok(cwd) = std::env::current_dir() else { return empty(); };
        let root = cwd.join("managed-skills");
        let Ok(canonical_root) = std::fs::canonicalize(&root) else { return empty(); };
        let Ok(canonical_cwd) = std::fs::canonicalize(&cwd) else { return empty(); };
        if canonical_root != canonical_cwd.join("managed-skills") { return empty(); }
        if std::fs::canonicalize(root.join("catalog.json")).ok() != Some(canonical_root.join("catalog.json")) { return empty(); }
        let Ok(bytes) = std::fs::read(root.join("catalog.json")) else { return empty(); };
        if bytes.len() > 32768 { return empty(); }
        let Ok(entries) = serde_json::from_slice::<Vec<String>>(&bytes) else { return empty(); };
        if entries.len() > 101 { return empty(); }
        let mut roots = Vec::new();
        for entry in entries {
            let relative = std::path::Path::new(&entry);
            if relative.components().count() != 2 || relative.components().any(|c| !matches!(c, std::path::Component::Normal(_))) { return empty(); }
            let path = root.join(relative);
            let Ok(canonical) = std::fs::canonicalize(&path) else { return empty(); };
            if canonical != canonical_root.join(relative) { return empty(); }
            // Reject links and unexpected files before the upstream recursive scanner.
            let Ok(children) = std::fs::read_dir(&path) else { return empty(); };
            for child in children {
                let Ok(child) = child else { return empty(); };
                let Ok(kind) = child.file_type() else { return empty(); };
                if kind.is_file() && child.file_name() == "SKILL.md" {
                    if child.metadata().map(|m| m.len() > 65536).unwrap_or(true) { return empty(); }
                } else if kind.is_dir() && child.file_name() == "agents" {
                    let Ok(metadata) = std::fs::read_dir(child.path()) else { return empty(); };
                    for item in metadata {
                        let Ok(item) = item else { return empty(); };
                        if item.file_name() != "openai.yaml" || !item.file_type().map(|t| t.is_file()).unwrap_or(false) || item.metadata().map(|m| m.len() > 4096).unwrap_or(true) { return empty(); }
                    }
                } else { return empty(); }
            }
            let Ok(path) = AbsolutePathBuf::try_from(path) else { return empty(); };
            roots.push(HostSkillRoot::host(path, SkillScope::User, Arc::clone(&LOCAL_FS)));
        }
        let rules = skill_config_rules_from_stack(&input.config_layer_stack);
        HostSkillsSnapshot::new(Arc::new(self.build_skill_outcome(input, roots, &rules, None).await))
    }
