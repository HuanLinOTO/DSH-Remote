// ============================================
// Unified Bridge Commands
//
// A single set of Tauri commands that transparently proxies both
// HTTP streaming (SSE) and WebSocket (PTY) connections.
//
// The frontend picks the transport by URL scheme:
//   ws:// / wss://   → WebSocket (bidirectional)
//   http:// / https:// → HTTP stream  (read-only)
// ============================================

use crate::app::bridge::{
    BridgeCommand, BridgeConnection, BridgeEvent, BridgeKey, BridgeState, ConnectArgs,
    DisconnectArgs, SendArgs,
};
use futures_util::{SinkExt, StreamExt};
use std::time::Duration;
use tauri::{ipc::Channel, State};
use tokio::sync::mpsc;

fn emit(channel: &Channel<BridgeEvent>, event: BridgeEvent) {
    if let Err(error) = channel.send(event) {
        log::warn!("bridge: channel send failed: {error}");
    }
}

fn split_valid_utf8_prefix(bytes: &[u8]) -> Option<(String, usize)> {
    if bytes.is_empty() {
        return None;
    }

    match std::str::from_utf8(bytes) {
        Ok(text) => Some((text.to_string(), bytes.len())),
        Err(error) => {
            let valid_up_to = error.valid_up_to();

            if let Some(error_len) = error.error_len() {
                let consumed = valid_up_to + error_len;
                let text = String::from_utf8_lossy(&bytes[..consumed]).into_owned();
                Some((text, consumed))
            } else if valid_up_to > 0 {
                let text = std::str::from_utf8(&bytes[..valid_up_to])
                    .expect("valid_up_to must point to a valid UTF-8 prefix")
                    .to_string();
                Some((text, valid_up_to))
            } else {
                None
            }
        }
    }
}

fn emit_stream_chunk(channel: &Channel<BridgeEvent>, pending_utf8: &mut Vec<u8>, chunk: &[u8]) {
    if chunk.is_empty() {
        return;
    }

    pending_utf8.extend_from_slice(chunk);

    while let Some((text, consumed)) = split_valid_utf8_prefix(pending_utf8.as_slice()) {
        pending_utf8.drain(..consumed);
        if !text.is_empty() {
            emit(channel, BridgeEvent::Data { data: text });
        }
    }
}

// ============================================
// 应用层心跳（native pong）
// ============================================

/// 服务器通过 JSON `{"type":"ping"}` 控制帧做应用层心跳，此前由 WebView 里的 JS
/// 回 pong。WebView 切后台会被浏览器冻结（定时器/IPC 重度节流到分钟级），pong
/// 断供后服务器以 4009 "heartbeat timeout" 关闭控制通道，而冻结同样推迟退避
/// 重连 —— 表现为回到前台后主机永远"不在线"。这里在原生层直接回应答，与下方
/// WS 协议层 Ping/Pong 的处理对齐，心跳不再依赖 WebView 存活。
fn native_pong_frame(text: &str, counter: u64) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    if value.get("type").and_then(|t| t.as_str()) != Some("ping") {
        return None;
    }

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let now_ms = u64::try_from(now.as_millis()).unwrap_or(0);

    let mut pong = value;
    pong["type"] = serde_json::Value::String("pong".to_string());
    pong["timestamp"] = serde_json::Value::Number(serde_json::Number::from(now_ms));
    // The Server validates every frame id as a ULID/UUID (any RFC 4122 version;
    // the official JS client sends crypto.randomUUID() = v4). Hand-rolled ids
    // like "pong-{ms}-{n}" are rejected with 4008 INVALID_MESSAGE and the
    // control channel is closed immediately (verified 2026-09-06), so emit a
    // v4-shaped UUID instead.
    pong["id"] = serde_json::Value::String(format_v4_uuid(now.as_nanos(), counter));
    Some(pong.to_string())
}

/// Format a v4-shaped UUID from (nanos, counter) avalanched through RandomState.
/// The heartbeat pong id only needs to pass format validation and stay unique
/// within a connection; it carries no security value, so a CSPRNG is unnecessary.
fn format_v4_uuid(nanos: u128, counter: u64) -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};

    let mut left = RandomState::new().build_hasher();
    left.write_u128(nanos);
    left.write_u64(counter);
    let a = left.finish();

    let mut right = RandomState::new().build_hasher();
    right.write_u64(a ^ counter.wrapping_mul(0x9E37_79B9_7F4A_7C15));
    let b = right.finish();

    let mut bytes = [0u8; 16];
    bytes[..8].copy_from_slice(&a.to_be_bytes());
    bytes[8..].copy_from_slice(&b.to_be_bytes());
    bytes[6] = (bytes[6] & 0x0F) | 0x40;
    bytes[8] = (bytes[8] & 0x3F) | 0x80;

    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

// ============================================
// bridge_connect — auto-selects transport
// ============================================

#[tauri::command]
pub async fn bridge_connect(
    window: tauri::Window,
    state: State<'_, BridgeState>,
    args: ConnectArgs,
    on_event: Channel<BridgeEvent>,
) -> Result<(), String> {
    if args.is_websocket() {
        connect_ws(window, state, args, on_event).await
    } else {
        connect_stream(window, state, args, on_event).await
    }
}

// ============================================
// bridge_send — WebSocket only
// ============================================

#[tauri::command]
pub async fn bridge_send(
    window: tauri::Window,
    state: State<'_, BridgeState>,
    args: SendArgs,
) -> Result<(), String> {
    let key = BridgeKey::new(window.label(), args.bridge_id());
    let sender = state
        .sender(&key)
        .ok_or_else(|| format!("bridge '{}' is not active", args.bridge_id()))?;

    log::info!(
        "bridge: ws send id={} bytes={}",
        args.bridge_id(),
        args.data().len()
    );
    sender
        .send(BridgeCommand::Send(args.data().to_string()))
        .map_err(|_| format!("bridge '{}' is closed", args.bridge_id()))
}

// ============================================
// bridge_disconnect
// ============================================

#[tauri::command]
pub async fn bridge_disconnect(
    window: tauri::Window,
    state: State<'_, BridgeState>,
    args: DisconnectArgs,
) -> Result<(), String> {
    let key = BridgeKey::new(window.label(), args.bridge_id());
    state.disconnect(&key);
    Ok(())
}

// ============================================
// HTTP stream transport (for SSE)
// ============================================

async fn connect_stream(
    window: tauri::Window,
    state: State<'_, BridgeState>,
    args: ConnectArgs,
    on_event: Channel<BridgeEvent>,
) -> Result<(), String> {
    let conn_id = state.next_conn_id();
    let key = BridgeKey::new(window.label(), args.bridge_id());

    // Replace any previous connection with the same key
    if let Some(prev) = state.replace(key.clone(), BridgeConnection::new_stream(conn_id)) {
        if let Some(tx) = prev.tx {
            let _ = tx.send(BridgeCommand::Close);
        }
    }

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .tcp_keepalive(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("failed to create HTTP client: {}", e))?;

    let mut req = client.get(args.url());
    if let Some(auth) = args.auth_header() {
        req = req.header("Authorization", auth);
    }

    let response = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            let msg = format!("HTTP stream connection failed: {}", e);
            emit(
                &on_event,
                BridgeEvent::Error {
                    message: msg.clone(),
                },
            );
            state.remove_if_current(&key, conn_id);
            return Err(msg);
        }
    };

    if !response.status().is_success() {
        let msg = format!("HTTP stream server returned {}", response.status());
        emit(
            &on_event,
            BridgeEvent::Error {
                message: msg.clone(),
            },
        );
        state.remove_if_current(&key, conn_id);
        return Err(msg);
    }

    emit(&on_event, BridgeEvent::Connected);

    // Read timeout — if no data arrives for 90s the connection is likely dead
    const READ_TIMEOUT: Duration = Duration::from_secs(90);
    let mut stream = response.bytes_stream();
    let mut pending_utf8 = Vec::new();

    loop {
        // Check cancellation (disconnect or replaced by a new connect)
        if !state.is_current(&key, conn_id) {
            emit(
                &on_event,
                BridgeEvent::Disconnected {
                    code: None,
                    reason: "Disconnected by client".to_string(),
                },
            );
            return Ok(());
        }

        match tokio::time::timeout(READ_TIMEOUT, stream.next()).await {
            Ok(Some(Ok(chunk))) => {
                emit_stream_chunk(&on_event, &mut pending_utf8, chunk.as_ref());
            }
            Ok(Some(Err(e))) => {
                let msg = format!("HTTP stream error: {}", e);
                emit(
                    &on_event,
                    BridgeEvent::Error {
                        message: msg.clone(),
                    },
                );
                state.remove_if_current(&key, conn_id);
                return Err(msg);
            }
            Ok(None) => {
                state.remove_if_current(&key, conn_id);
                emit(
                    &on_event,
                    BridgeEvent::Disconnected {
                        code: None,
                        reason: "Stream ended".to_string(),
                    },
                );
                return Ok(());
            }
            Err(_) => {
                let msg = format!(
                    "HTTP stream read timeout ({}s without data)",
                    READ_TIMEOUT.as_secs()
                );
                emit(
                    &on_event,
                    BridgeEvent::Error {
                        message: msg.clone(),
                    },
                );
                state.remove_if_current(&key, conn_id);
                return Err(msg);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{native_pong_frame, split_valid_utf8_prefix};

    #[test]
    fn split_valid_utf8_prefix_waits_for_incomplete_chinese_bytes() {
        let text = "中文A";
        let bytes = text.as_bytes();

        assert_eq!(split_valid_utf8_prefix(&bytes[..2]), None);
        assert_eq!(
            split_valid_utf8_prefix(&bytes[..3]),
            Some(("中".to_string(), 3))
        );
        assert_eq!(
            split_valid_utf8_prefix(bytes),
            Some((text.to_string(), bytes.len()))
        );
    }

    #[test]
    fn split_valid_utf8_prefix_returns_valid_prefix_before_incomplete_tail() {
        let mut bytes = "中文".as_bytes().to_vec();
        bytes.extend_from_slice(&"世".as_bytes()[..2]);

        assert_eq!(
            split_valid_utf8_prefix(&bytes),
            Some(("中文".to_string(), "中文".len()))
        );
    }

    #[test]
    fn native_pong_frame_echoes_ping_payload() {
        let ping = r#"{"v":1,"id":"01a076fe","type":"ping","timestamp":1788702766903,"payload":{"nonce":"n-1"}}"#;
        let pong = native_pong_frame(ping, 7).expect("ping must produce a pong");
        let value: serde_json::Value = serde_json::from_str(&pong).expect("pong must be valid JSON");

        assert_eq!(value["type"], "pong");
        assert_eq!(value["v"], 1);
        assert_eq!(value["payload"]["nonce"], "n-1");
        assert_ne!(value["id"], "01a076fe"); // mirror the JS client: fresh id
        let id = value["id"].as_str().expect("pong id must be a string");
        assert!(is_uuid_shape(id), "pong id must be UUID-shaped, got {id}");
        assert!(value["timestamp"].as_u64().unwrap_or(0) > 0);
    }

    /// ULID/UUID wire format: 8-4-4-4-12 hex with a version nibble and RFC 4122
    /// variant. The Server rejects anything else with 4008 INVALID_MESSAGE.
    fn is_uuid_shape(value: &str) -> bool {
        let bytes = value.as_bytes();
        if bytes.len() != 36 {
            return false;
        }
        for pos in [8, 13, 18, 23] {
            if bytes[pos] != b'-' {
                return false;
            }
        }
        value
            .bytes()
            .filter(|byte| *byte != b'-')
            .all(|byte| byte.is_ascii_hexdigit())
            && bytes[14] >= b'1'
            && bytes[14] <= b'8'
            && matches!(bytes[19], b'8' | b'9' | b'a' | b'b')
    }

    #[test]
    fn native_pong_frame_ignores_non_ping_frames() {
        let hello = r#"{"v":1,"id":"x","type":"hello","timestamp":1,"payload":{}}"#;
        assert_eq!(native_pong_frame(hello, 1), None);
        assert_eq!(native_pong_frame("not json", 1), None);
        assert_eq!(native_pong_frame(r#"{"type":"pong","payload":{}}"#, 1), None);
    }
}

// ============================================
// WebSocket transport (for PTY)
// ============================================

async fn connect_ws(
    window: tauri::Window,
    state: State<'_, BridgeState>,
    args: ConnectArgs,
    on_event: Channel<BridgeEvent>,
) -> Result<(), String> {
    use tokio_tungstenite::{
        connect_async,
        tungstenite::{client::IntoClientRequest, http::HeaderValue, Error as WsError, Message},
    };

    let conn_id = state.next_conn_id();
    let key = BridgeKey::new(window.label(), args.bridge_id());
    let (tx, mut rx) = mpsc::unbounded_channel();

    // Replace any previous connection with the same key
    if let Some(prev) = state.replace(key.clone(), BridgeConnection::new_ws(conn_id, tx)) {
        if let Some(prev_tx) = prev.tx {
            let _ = prev_tx.send(BridgeCommand::Close);
        }
    }

    let mut request = args
        .url()
        .into_client_request()
        .map_err(|e| format!("invalid WebSocket URL: {}", e))?;

    if let Some(auth) = args.auth_header() {
        let value = HeaderValue::from_str(auth)
            .map_err(|e| format!("invalid Authorization header: {}", e))?;
        request.headers_mut().insert("Authorization", value);
    }

    log::info!("bridge: ws dial id={} url={}", args.bridge_id(), args.url());

    let (ws_stream, _) = match connect_async(request).await {
        Ok(result) => result,
        Err(error) => {
            let message = match error {
                WsError::Http(response) => {
                    format!("WebSocket server returned {}", response.status())
                }
                other => format!("WebSocket connection failed: {}", other),
            };
            log::warn!("bridge: ws dial failed id={} error={}", args.bridge_id(), message);
            emit(
                &on_event,
                BridgeEvent::Error {
                    message: message.clone(),
                },
            );
            state.remove_if_current(&key, conn_id);
            return Err(message);
        }
    };

    log::info!("bridge: ws connected id={}", args.bridge_id());

    emit(&on_event, BridgeEvent::Connected);

    let (mut write, mut read) = ws_stream.split();
    let app_pong_counter = std::sync::atomic::AtomicU64::new(0);

    loop {
        tokio::select! {
            outbound = rx.recv() => match outbound {
                Some(BridgeCommand::Send(data)) => {
                    let bytes = data.len();
                    if let Err(error) = write.send(Message::Text(data.into())).await {
                        let msg = format!("WebSocket write failed: {}", error);
                        emit(&on_event, BridgeEvent::Error { message: msg.clone() });
                        state.remove_if_current(&key, conn_id);
                        return Err(msg);
                    }
                    log::info!("bridge: ws sent id={} bytes={}", args.bridge_id(), bytes);
                }
                Some(BridgeCommand::Close) | None => {
                    let _ = write.close().await;
                    state.remove_if_current(&key, conn_id);
                    emit(&on_event, BridgeEvent::Disconnected {
                        code: Some(1000),
                        reason: "Disconnected by client".to_string(),
                    });
                    return Ok(());
                }
            },
            inbound = read.next() => match inbound {
                Some(Ok(message)) => match message {
                    Message::Text(text) => {
                        // 应用层心跳原生回应（见 native_pong_frame 注释）；帧仍
                        // 转发给 JS，供其自身的统计/状态机使用。
                        if let Some(pong) = native_pong_frame(
                            &text,
                            app_pong_counter.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
                        ) {
                            let bytes = pong.len();
                            if let Err(error) = write.send(Message::Text(pong.into())).await {
                                let msg = format!("WebSocket write failed: {}", error);
                                emit(&on_event, BridgeEvent::Error { message: msg.clone() });
                                state.remove_if_current(&key, conn_id);
                                return Err(msg);
                            }
                            log::info!(
                                "bridge: ws sent id={} bytes={} (app-level pong)",
                                args.bridge_id(),
                                bytes
                            );
                        }
                        // Non-relay control frames are small and rare; log them
                        // so remote-side rejections stay visible in app logs.
                        if !text.contains("\"relay\"") {
                            let end = text.len().min(300);
                            log::info!("bridge: ws recv id={} frame={}", args.bridge_id(), &text[..end]);
                        }
                        emit(&on_event, BridgeEvent::Data { data: text.to_string() });
                    }
                    Message::Binary(bytes) => {
                        emit(&on_event, BridgeEvent::Data {
                            data: String::from_utf8_lossy(&bytes).into_owned(),
                        });
                    }
                    Message::Ping(payload) => {
                        if let Err(error) = write.send(Message::Pong(payload)).await {
                            let msg = format!("WebSocket pong failed: {}", error);
                            emit(&on_event, BridgeEvent::Error { message: msg.clone() });
                            state.remove_if_current(&key, conn_id);
                            return Err(msg);
                        }
                    }
                    Message::Pong(_) => {}
                    Message::Close(frame) => {
                        let code = frame.as_ref().map(|f| u16::from(f.code));
                        let reason = frame
                            .map(|f| f.reason.to_string())
                            .unwrap_or_else(|| "Connection closed by server".to_string());
                        log::info!(
                            "bridge: ws closed by server id={} code={:?} reason={}",
                            args.bridge_id(),
                            code,
                            reason
                        );
                        state.remove_if_current(&key, conn_id);
                        emit(&on_event, BridgeEvent::Disconnected { code, reason });
                        return Ok(());
                    }
                    _ => {}
                },
                Some(Err(error)) => {
                    let msg = format!("WebSocket stream error: {}", error);
                    log::warn!("bridge: ws stream error id={} error={}", args.bridge_id(), msg);
                    emit(&on_event, BridgeEvent::Error { message: msg.clone() });
                    state.remove_if_current(&key, conn_id);
                    return Err(msg);
                }
                None => {
                    state.remove_if_current(&key, conn_id);
                    emit(&on_event, BridgeEvent::Disconnected {
                        code: None,
                        reason: "Stream ended".to_string(),
                    });
                    return Ok(());
                }
            }
        }
    }
}
