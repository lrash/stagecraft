fn main() {
    // Restrict the app's own IPC surface to exactly these commands (DESIGN R-72). Each one gets
    // an `allow-<name>` permission, granted in capabilities/ or capabilities-runtime/.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "state_save",
            "save_export",
            "sys_info",
            "flush_done",
            "ollama_pull",
            "ollama_pull_cancel",
            "selftest_report",
            "cloud_enable",
            "cloud_disable",
            "cloud_provider_set",
            "cloud_fetch",
            "cloud_fetch_cancel",
            "secret_set",
            "secret_has",
            "secret_delete",
            "openrouter_sign_in",
        ]),
    ))
    .expect("failed to run tauri-build");
}
