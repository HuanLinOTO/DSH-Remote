use serde::Serialize;

/// Unified bridge event pushed to the frontend via Tauri Channel.
///
/// The Rust layer is a transparent proxy — `data` is forwarded as-is
/// without parsing or field renaming. The frontend decides how to
/// interpret it (SSE line parsing, terminal output, etc.).
// NOTE: variant tags MUST stay PascalCase (`Connected`, `Data`, …) — the
// frontend adapter (src/dsh/lib/tauri-websocket.ts `handleBridgeEvent`)
// matches exactly these strings. A previous `rename_all = "camelCase"`
// lowercased them ("connected"), every event fell through the frontend
// switch, the control-channel hello was never sent and the server closed
// with 4001 "hello not received in time". Guarded by the test below.
#[derive(Clone, Serialize)]
#[serde(tag = "event", content = "data")]
pub enum BridgeEvent {
    Connected,
    Data { data: String },
    Disconnected { code: Option<u16>, reason: String },
    Error { message: String },
}

#[cfg(test)]
mod tests {
    use super::BridgeEvent;

    /// The wire format the frontend adapter switches on — lock it down.
    #[test]
    fn serialization_matches_frontend_contract() {
        assert_eq!(
            serde_json::to_string(&BridgeEvent::Connected).unwrap(),
            r#"{"event":"Connected"}"#
        );
        assert_eq!(
            serde_json::to_string(&BridgeEvent::Data { data: "x".into() }).unwrap(),
            r#"{"event":"Data","data":{"data":"x"}}"#
        );
        assert_eq!(
            serde_json::to_string(&BridgeEvent::Disconnected {
                code: Some(4001),
                reason: "hello not received in time".into()
            })
            .unwrap(),
            r#"{"event":"Disconnected","data":{"code":4001,"reason":"hello not received in time"}}"#
        );
        assert_eq!(
            serde_json::to_string(&BridgeEvent::Error { message: "m".into() }).unwrap(),
            r#"{"event":"Error","data":{"message":"m"}}"#
        );
    }
}
