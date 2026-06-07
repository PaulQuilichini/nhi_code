use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::{Manager, RunEvent};

struct ApiServer(Mutex<Option<Child>>);

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let child = spawn_api_server(app.handle())?;
            app.manage(ApiServer(Mutex::new(Some(child))));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let RunEvent::Exit = event {
                if let Some(state) = app_handle.try_state::<ApiServer>() {
                    if let Ok(mut guard) = state.0.lock() {
                        if let Some(mut child) = guard.take() {
                            let _ = child.kill();
                            let _ = child.wait();
                        }
                    }
                }
            }
        });
}

fn spawn_api_server(app: &tauri::AppHandle) -> Result<Child, String> {
    let node = find_node_executable()?;
    let (desktop_dir, repo_root) = resolve_paths(app)?;

    let mut cmd = if cfg!(debug_assertions) {
        // Development: run TypeScript server with tsx
        let tsx = desktop_dir
            .join("node_modules")
            .join("tsx")
            .join("dist")
            .join("cli.mjs");
        let server_entry = desktop_dir.join("server").join("index.ts");

        if !tsx.exists() {
            return Err(format!(
                "tsx not found at {}. Run pnpm install in the project root.",
                tsx.display()
            ));
        }

        let mut c = Command::new(&node);
        c.arg(&tsx).arg(&server_entry);
        c
    } else {
        // Production: bundled server script
        let bundle = app
            .path()
            .resource_dir()
            .map_err(|e| e.to_string())?
            .join("server")
            .join("bundle.cjs");

        if !bundle.exists() {
            return Err(format!("Server bundle not found at {}", bundle.display()));
        }

        let mut c = Command::new(&node);
        c.arg(&bundle);
        c
    };

    cmd.current_dir(&desktop_dir)
        .env("NHICODE_ROOT", &repo_root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    cmd.spawn().map_err(|e| format!("Failed to start API server: {e}"))
}

fn resolve_paths(app: &tauri::AppHandle) -> Result<(PathBuf, PathBuf), String> {
    if cfg!(debug_assertions) {
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let desktop_dir = manifest
            .parent()
            .ok_or("Invalid desktop path")?
            .to_path_buf();
        let repo_root = desktop_dir
            .parent()
            .and_then(|p| p.parent())
            .ok_or("Invalid repo root")?
            .to_path_buf();
        Ok((desktop_dir, repo_root))
    } else {
        let resource = app.path().resource_dir().map_err(|e| e.to_string())?;
        let repo_root = std::env::current_dir().map_err(|e| e.to_string())?;
        Ok((resource, repo_root))
    }
}

fn find_node_executable() -> Result<PathBuf, String> {
    if let Ok(path) = which_node() {
        return Ok(path);
    }

    let candidates = node_candidates();
    for c in candidates {
        if c.exists() {
            return Ok(c);
        }
    }

    Err(
        "Node.js not found. Install Node.js 20+ or run the NHI Code setup script.".into(),
    )
}

fn which_node() -> Result<PathBuf, String> {
    let cmd = if cfg!(windows) { "where" } else { "which" };
    let output = Command::new(cmd)
        .arg("node")
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        return Err("node not in PATH".into());
    }

    let line = String::from_utf8_lossy(&output.stdout)
        .lines()
        .next()
        .unwrap_or("")
        .trim()
        .to_string();

    if line.is_empty() {
        return Err("empty node path".into());
    }

    Ok(PathBuf::from(line))
}

fn node_candidates() -> Vec<PathBuf> {
    let mut paths = Vec::new();

    #[cfg(windows)]
    {
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            let local = PathBuf::from(local);
            paths.push(local.join("NHICode").join("nodejs").join("node.exe"));
            // prior install locations
            paths.push(local.join("SuprModl").join("nodejs").join("node.exe"));
            paths.push(local.join("SuperModel").join("nodejs").join("node.exe"));
        }
        if let Ok(pf) = std::env::var("ProgramFiles") {
            paths.push(PathBuf::from(pf).join("nodejs").join("node.exe"));
        }
    }

    #[cfg(target_os = "macos")]
    {
        paths.push(PathBuf::from("/usr/local/bin/node"));
        paths.push(PathBuf::from("/opt/homebrew/bin/node"));
        if let Ok(home) = std::env::var("HOME") {
            let share = PathBuf::from(home).join(".local").join("share");
            paths.push(share.join("nhicode").join("nodejs").join("bin").join("node"));
            paths.push(share.join("suprmodl").join("nodejs").join("bin").join("node"));
            paths.push(share.join("supermodel").join("nodejs").join("bin").join("node"));
        }
    }

    #[cfg(target_os = "linux")]
    {
        paths.push(PathBuf::from("/usr/bin/node"));
        if let Ok(home) = std::env::var("HOME") {
            let share = PathBuf::from(home).join(".local").join("share");
            paths.push(share.join("nhicode").join("nodejs").join("bin").join("node"));
            paths.push(share.join("suprmodl").join("nodejs").join("bin").join("node"));
            paths.push(share.join("supermodel").join("nodejs").join("bin").join("node"));
        }
    }

    paths
}
