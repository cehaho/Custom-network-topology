fn main() {
    const COMMANDS: &[&str] = &[
        "config_load",
        "config_save",
        "config_export",
        "config_import",
        "config_discard_import",
        "ssh_browse_key",
        "ssh_connect",
        "ssh_write",
        "ssh_resize",
        "ssh_disconnect",
        "ssh_forget_host_key",
        "ssh_known_hosts_list",
        "ssh_known_hosts_import_openssh",
        "network_local_info",
        "network_ping",
        "network_scan",
        "network_arp",
        "network_neighbors",
        "network_enrich",
        "monitor_start",
        "monitor_stop",
        "alerts_notify",
        "image_export",
        "actions_open_web",
        "actions_traceroute",
        "actions_wake",
    ];
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run tauri-build");
}
