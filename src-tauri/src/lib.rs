use std::sync::Mutex;
use tauri::{Emitter, Manager};
use tauri_plugin_shell::{process::CommandChild, process::CommandEvent, ShellExt};

// Keep CommandChild alive so the long-running SDK sidecar can receive commands.
struct SdkBridge {
    child: Mutex<CommandChild>,
}

#[tauri::command]
fn sdk_command(
    bridge: tauri::State<'_, SdkBridge>,
    payload: serde_json::Value,
) -> Result<(), String> {
    let command = payload
        .get("command")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if !matches!(command, "init" | "start" | "stop") {
        return Err("Invalid SDK command".into());
    }
    let mut child = bridge.child.lock().map_err(|_| "Sidecar lock failed")?;
    child
        .write(format!("{payload}\n").as_bytes())
        .map_err(|error| error.to_string())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // In dev the script lives in the repo. In a bundle it is a resource
            // beside its intact node_modules directory and native SDK files.
            let script = if cfg!(debug_assertions) {
                std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .parent()
                    .unwrap()
                    .join("sidecar/index.cjs")
            } else {
                app.path().resource_dir()?.join("sidecar/index.cjs")
            };
            let (mut events, child) = app.shell().sidecar("node")?.arg(script).spawn()?;
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                while let Some(event) = events.recv().await {
                    match event {
                        CommandEvent::Stdout(line) => {
                            match serde_json::from_slice::<serde_json::Value>(&line) {
                                Ok(message) => {
                                    let _ = handle.emit("sdk-message", message);
                                }
                                Err(error) => eprintln!("Invalid sidecar JSON: {error}"),
                            }
                        }
                        CommandEvent::Stderr(line) => {
                            eprintln!("sidecar: {}", String::from_utf8_lossy(&line));
                        }
                        CommandEvent::Error(error) => eprintln!("Sidecar read failed: {error}"),
                        CommandEvent::Terminated(_) => break,
                        _ => {}
                    }
                }
                let _ = handle.emit("sdk-message", serde_json::json!({"type":"sidecar-exit"}));
            });
            app.manage(SdkBridge {
                child: Mutex::new(child),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![sdk_command])
        .run(tauri::generate_context!())
        .expect("error while running Tauri app");
}
