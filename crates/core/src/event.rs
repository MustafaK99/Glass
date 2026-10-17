//! UI-facing events. The rest of the app never sees protocol types.

use serde::Serialize;

use crate::proto::agent as pb;

/// One thing that happened in a session, in the order it happened.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Event {
    /// The worker accepted a message we sent.
    InputAccepted { message_id: String },
    /// The worker refused a message we sent.
    InputRejected { message_id: String, reason: String },
    TurnStarted,
    /// Streamed assistant text.
    Text { delta: String },
    /// Streamed reasoning.
    Reasoning { delta: String },
    /// A tool call being written by the model, piece by piece.
    ToolCallDelta { index: u32, name: String, arguments: String },
    /// The worker wants a yes or no before running this tool call.
    ApprovalRequested { call_id: String, tool: String, arguments: String },
    ApprovalResolved { call_id: String, approved: bool },
    /// How a tool call's approval ended up: `outcome` is requested, approved, denied
    /// or canceled; `source` is manual, automatic, not_required, remembered_exact or
    /// remembered_prefix. Lets the transcript say why a call ran without asking.
    ApprovalRecorded { call_id: String, tool: String, outcome: String, source: String },
    /// A finished record: a user message, an assistant message or a tool result.
    Message(Message),
    /// A background task changed state.
    Task { id: String, tool: String, status: String, display: Option<String> },
    ContextUsage { tokens: u64, window: u64 },
    /// Where the context is going: system prompt and tool definitions.
    ContextReport { system_tokens: u64, tool_tokens: u64, tools: Vec<String> },
    Speed { tokens_per_second: f64 },
    CompactionStarted,
    Rewound { entry_id: String, removed_entries: u64 },
    Log { level: String, text: String },
    TurnCompleted,
    TurnInterrupted,
    TurnError { message: String },
    /// The worker wants a tool the client hosts, such as an MCP tool, run.
    /// Answer it with [`crate::Session::host_tool_result`].
    HostToolCall { call_id: String, name: String, arguments: String },
    /// The stream ended. `error` is set when it did not end cleanly.
    Closed { error: Option<String> },
}

/// A finished conversation record.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Message {
    pub id: String,
    pub role: Role,
    pub content: String,
    pub reasoning: Option<String>,
    pub tool_calls: Vec<ToolCall>,
    /// For tool results: the call this answers.
    pub tool_call_id: Option<String>,
    /// For tool results: what the worker suggests showing instead of raw content.
    pub display: Option<String>,
    pub success: bool,
    /// Files this record read, wrote or listed.
    pub touched: Vec<Touched>,
    pub exit_code: Option<i32>,
    pub usage: Option<Usage>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    System,
    User,
    Assistant,
    Tool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Touched {
    pub path: String,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Usage {
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub cached_tokens: u64,
}

impl Event {
    /// Translate one protocol message. A single message can carry more than one event.
    pub fn from_session_message(message: pb::SessionMessage) -> Vec<Event> {
        use pb::session_message::Payload;
        let mut events = Vec::new();
        if let Some(speed) = message.tokens_per_second {
            events.push(Event::Speed { tokens_per_second: speed });
        }
        match message.payload {
            Some(Payload::AgentMessage(record)) => events.extend(from_record(record)),
            Some(Payload::HitlRequest(request)) => {
                if let Some(call) = request.call {
                    let function = call.function.unwrap_or_default();
                    events.push(Event::ApprovalRequested {
                        call_id: call.id,
                        tool: function.name,
                        arguments: function.arguments,
                    });
                }
            }
            Some(Payload::HitlResolved(resolved)) => events.push(Event::ApprovalResolved {
                call_id: resolved.call_id,
                approved: resolved.approved,
            }),
            Some(Payload::RuntimeDelta(delta)) => events.extend(from_delta(delta)),
            Some(Payload::InputAck(ack)) => {
                events.push(Event::InputAccepted { message_id: ack.message_id })
            }
            Some(Payload::InputNack(nack)) => {
                let reason = if nack.error.is_empty() {
                    pb::InputNackReason::try_from(nack.reason)
                        .map(|reason| reason.as_str_name().to_string())
                        .unwrap_or_else(|_| "unknown".to_string())
                } else {
                    nack.error
                };
                events.push(Event::InputRejected { message_id: nack.message_id, reason })
            }
            Some(Payload::HostToolCall(call)) => {
                let function = call.function.unwrap_or_default();
                events.push(Event::HostToolCall { call_id: call.id, name: function.name, arguments: function.arguments });
            }
            // Replay markers are handled by the session, not the UI.
            Some(Payload::ReplayDone(_)) | None => {}
        }
        events
    }
}

fn from_delta(delta: pb::RuntimeDelta) -> Option<Event> {
    use pb::runtime_delta::Payload;
    Some(match delta.payload? {
        Payload::StreamContent(part) => Event::Text { delta: part.content },
        Payload::StreamReasoning(part) => Event::Reasoning { delta: part.reasoning },
        Payload::StreamRefusal(part) => Event::Text { delta: part.refusal },
        Payload::StreamToolCall(part) => Event::ToolCallDelta {
            index: part.index,
            name: part.name,
            arguments: part.arguments,
        },
        Payload::StreamAborted(_) => Event::TurnInterrupted,
        Payload::CompactionStarted(_) => Event::CompactionStarted,
        Payload::ContextUsage(usage) => {
            Event::ContextUsage { tokens: usage.tokens, window: usage.window }
        }
        Payload::TaskUpdate(task) => Event::Task {
            status: pb::TaskStatus::try_from(task.status)
                .map(|status| status.as_str_name().trim_start_matches("TASK_STATUS_").to_lowercase())
                .unwrap_or_else(|_| "unknown".to_string()),
            id: task.id,
            tool: task.tool_name,
            display: task.display,
        },
        Payload::TurnCompleted(_) => Event::TurnCompleted,
        Payload::TurnInterrupted(_) => Event::TurnInterrupted,
        Payload::TurnError(error) => Event::TurnError { message: error.message },
        Payload::Rewound(rewound) => Event::Rewound {
            entry_id: rewound.entry_id,
            removed_entries: rewound.removed_entries.into(),
        },
        // Per-stream usage arrives again on the finished record, so it is not surfaced twice.
        Payload::StreamUsage(_) => return None,
        Payload::TurnStarted(_) => Event::TurnStarted,
    })
}

fn from_record(record: pb::AgentMessage) -> Option<Event> {
    use pb::agent_message::Payload;
    let touched = record
        .metadata
        .as_ref()
        .map(|metadata| {
            metadata
                .touched
                .iter()
                .map(|touched| Touched {
                    path: touched.path.clone(),
                    kind: pb::TouchedKind::try_from(touched.kind)
                        .map(|kind| kind.as_str_name().trim_start_matches("TOUCHED_KIND_").to_lowercase())
                        .unwrap_or_else(|_| "unknown".to_string()),
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let exit_code = record.metadata.as_ref().and_then(|metadata| metadata.exit_code);
    Some(match record.payload? {
        Payload::Chat(chat) => {
            use pb::chat_record::Message as Kind;
            let usage = chat.usage.map(|usage| Usage {
                prompt_tokens: usage.prompt_tokens,
                completion_tokens: usage.completion_tokens,
                cached_tokens: usage.cached_tokens,
            });
            let mut message = Message {
                id: record.id,
                role: Role::System,
                content: String::new(),
                reasoning: None,
                tool_calls: Vec::new(),
                tool_call_id: None,
                display: chat.display,
                success: chat.success,
                touched,
                exit_code,
                usage,
            };
            match chat.message? {
                Kind::System(system) => message.content = system.content,
                Kind::User(user) => {
                    message.role = Role::User;
                    message.content = user.content;
                }
                Kind::Assistant(assistant) => {
                    message.role = Role::Assistant;
                    message.content = assistant.content.or(assistant.refusal).unwrap_or_default();
                    message.reasoning = assistant.reasoning_content;
                    message.tool_calls = assistant
                        .tool_calls
                        .into_iter()
                        .map(|call| {
                            let function = call.function.unwrap_or_default();
                            ToolCall { id: call.id, name: function.name, arguments: function.arguments }
                        })
                        .collect();
                }
                Kind::Tool(tool) => {
                    message.role = Role::Tool;
                    message.content = tool.content;
                    message.tool_call_id = Some(tool.tool_call_id);
                }
            }
            Event::Message(message)
        }
        Payload::Log(log) => Event::Log { level: log.level, text: log.text },
        Payload::ContextWindow(window) => {
            let report = window.system_prompt_report?;
            Event::ContextReport {
                system_tokens: report.estimated_tokens,
                tool_tokens: report.tool_tokens.unwrap_or(0),
                tools: report.tools.into_iter().map(|tool| tool.source).collect(),
            }
        }
        Payload::ToolApproval(approval) => Event::ApprovalRecorded {
            outcome: pb::ToolApprovalOutcome::try_from(approval.outcome)
                .map(|outcome| outcome.as_str_name().trim_start_matches("TOOL_APPROVAL_OUTCOME_").to_lowercase())
                .unwrap_or_else(|_| "unspecified".to_string()),
            source: pb::ApprovalSource::try_from(approval.source)
                .map(|source| source.as_str_name().trim_start_matches("APPROVAL_SOURCE_").to_lowercase())
                .unwrap_or_else(|_| "unspecified".to_string()),
            call_id: approval.call_id,
            tool: approval.tool_name,
        },
        Payload::TaskResult(_) | Payload::Extension(_) => return None,
    })
}
