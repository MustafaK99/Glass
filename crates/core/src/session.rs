//! One conversation with a running worker, over the `AgentRPC.Session` stream.

use anyhow::{anyhow, Context, Result};
use tokio::sync::mpsc;
use tokio_stream::wrappers::UnboundedReceiverStream;
use tokio_stream::StreamExt;
use tonic::transport::Channel;

use crate::event::Event;
use crate::proto::agent as pb;
use crate::proto::agent::agent_rpc_client::AgentRpcClient;

/// Mirror's own client allows 10 MB messages in both directions.
const MAX_MESSAGE_BYTES: usize = 10 * 1024 * 1024;
const HISTORY_PAGE: u32 = 1000;

/// Which model answers, where it runs, and how hard it thinks.
#[derive(Debug, Clone, Default)]
pub struct Inference {
    /// Model id, such as `Beam-501B-A23B`. Empty keeps the worker's choice.
    pub model: String,
    /// Wire protocol: `reflection`, `openrouter`, `openai-chat-completions`, `anthropic-messages`…
    pub api: Option<String>,
    /// Endpoint for a custom or self-hosted model.
    pub base_url: Option<String>,
    /// `low`, `medium`, `high`, `xhigh` or `max`. `None` keeps the provider default.
    pub reasoning_effort: Option<String>,
}

/// Whether the worker asks before running tools.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApprovalMode {
    /// Run every tool without asking.
    Auto,
    /// Ask first. Mirror calls this "manual".
    Manual,
}

/// A live session. Cloning is cheap; every clone sends on the same ordered stream.
#[derive(Clone)]
pub struct Session {
    conversation_id: String,
    outbox: mpsc::UnboundedSender<pb::ClientMessage>,
    client: AgentRpcClient<Channel>,
    channel: Channel,
}

impl Session {
    /// Open the session stream to a worker at `address` (from [`crate::Worker::address`]).
    ///
    /// Events arrive on the returned receiver in order, ending with [`Event::Closed`].
    pub async fn connect(
        address: &str,
        conversation_id: &str,
    ) -> Result<(Session, mpsc::UnboundedReceiver<Event>)> {
        let channel = Channel::from_shared(format!("http://{address}"))
            .context("worker address is not a valid endpoint")?
            .connect()
            .await
            .context("could not connect to mirror-agent")?;
        let mut client = AgentRpcClient::new(channel.clone())
            .max_decoding_message_size(MAX_MESSAGE_BYTES)
            .max_encoding_message_size(MAX_MESSAGE_BYTES);

        let (outbox, requests) = mpsc::unbounded_channel::<pb::ClientMessage>();
        let mut responses = client
            .session(UnboundedReceiverStream::new(requests))
            .await
            .context("mirror-agent rejected the session stream")?
            .into_inner();

        let (events, receiver) = mpsc::unbounded_channel();
        tokio::spawn(async move {
            let mut error = None;
            while let Some(next) = responses.next().await {
                match next {
                    Ok(message) => {
                        for event in Event::from_session_message(message) {
                            if events.send(event).is_err() {
                                return;
                            }
                        }
                    }
                    Err(status) => {
                        error = Some(format!("{}: {}", status.code(), status.message()));
                        break;
                    }
                }
            }
            let _ = events.send(Event::Closed { error });
        });

        Ok((Session { conversation_id: conversation_id.to_string(), outbox, client, channel }, receiver))
    }

    pub fn conversation_id(&self) -> &str {
        &self.conversation_id
    }

    /// Send a user message. If the agent is mid-turn, the worker queues it.
    /// Returns the message id, which comes back in [`Event::InputAccepted`].
    pub fn send_user(&self, text: &str) -> Result<String> {
        let id = new_id();
        let record = pb::AgentMessage {
            id: id.clone(),
            payload: Some(pb::agent_message::Payload::Chat(pb::ChatRecord {
                success: true,
                message: Some(pb::chat_record::Message::User(pb::UserMessage {
                    content: text.to_string(),
                })),
                ..Default::default()
            })),
            ..Default::default()
        };
        self.send(id.clone(), pb::client_message::Payload::Message(record))?;
        Ok(id)
    }

    /// Choose the model, endpoint and reasoning effort for the turns that follow.
    pub fn set_inference(&self, inference: &Inference) -> Result<()> {
        self.send(
            new_id(),
            pb::client_message::Payload::SetInferenceConfig(pb::InferenceConfig {
                model: inference.model.clone(),
                api: inference.api.clone(),
                base_url: inference.base_url.clone(),
                reasoning_effort: inference.reasoning_effort.clone(),
                ..Default::default()
            }),
        )
    }

    pub fn set_approval_mode(&self, mode: ApprovalMode) -> Result<()> {
        let mode = match mode {
            ApprovalMode::Auto => pb::ApprovalMode::Auto,
            ApprovalMode::Manual => pb::ApprovalMode::Hitl,
        };
        self.send(
            new_id(),
            pb::client_message::Payload::SetApprovalMode(pb::SetApprovalMode { mode: mode.into() }),
        )
    }

    /// Answer an [`Event::ApprovalRequested`].
    pub fn resolve_approval(&self, call_id: &str, approved: bool) -> Result<()> {
        self.send(
            new_id(),
            pb::client_message::Payload::HitlResponse(pb::HitlResponse {
                call_id: call_id.to_string(),
                approved,
            }),
        )
    }

    /// Stop the current turn.
    pub fn interrupt(&self) -> Result<()> {
        self.send(new_id(), pb::client_message::Payload::Interrupt(pb::Interrupt {}))
    }

    /// The result of an [`Event::HostToolCall`].
    pub fn host_tool_result(&self, call_id: &str, content: String, display: Option<String>, success: bool) -> Result<()> {
        self.send(
            format!("host-tool-result:{call_id}"),
            pb::client_message::Payload::HostToolResult(pb::HostToolResult {
                call_id: call_id.to_string(),
                content,
                display,
                success,
            }),
        )
    }

    /// Cancel one background task.
    pub fn cancel_task(&self, task_id: &str) -> Result<()> {
        self.send(
            new_id(),
            pb::client_message::Payload::CancelTask(pb::CancelTask { task_id: task_id.to_string() }),
        )
    }

    /// Run one of the worker's tools directly, with no model involved, such as
    /// `save_memory`. Returns the tool's output and whether it succeeded.
    pub async fn call_tool(&self, name: &str, arguments: &serde_json::Value) -> Result<(String, bool)> {
        let mut client = self.client.clone();
        let response = client
            .call_tool(pb::CallToolRequest {
                session_id: self.conversation_id.clone(),
                name: name.to_string(),
                arguments: arguments.to_string(),
            })
            .await
            .with_context(|| format!("mirror-agent could not run {name}"))?
            .into_inner();
        Ok((response.content, response.success))
    }

    /// A copy of this conversation that ends just before the user message `entry_id`.
    /// Returns the new conversation's id; launch a worker on it to continue from there.
    /// This is how Mirror's own client rewinds: the original conversation is kept.
    pub async fn fork(&self, entry_id: &str) -> Result<String> {
        use crate::proto::mirror as mpb;
        let mut client = mpb::mirror_rpc_client::MirrorRpcClient::new(self.channel.clone());
        let response = client
            .fork_session(mpb::ForkSessionRequest {
                source_session_id: self.conversation_id.clone(),
                at_entry_id: entry_id.to_string(),
                ..Default::default()
            })
            .await
            .context("mirror-agent could not fork the conversation")?;
        Ok(response.into_inner().session_id)
    }

    /// The conversation so far, oldest first. Use this to rebuild a transcript on resume.
    pub async fn history(&self) -> Result<Vec<Event>> {
        let mut client = self.client.clone();
        let mut events = Vec::new();
        let mut offset = 0u64;
        loop {
            let page = client
                .get_messages(pb::GetMessagesRequest {
                    session_id: self.conversation_id.clone(),
                    offset,
                    limit: HISTORY_PAGE,
                })
                .await
                .context("could not read conversation history")?
                .into_inner();
            if page.messages.is_empty() {
                break;
            }
            offset += page.messages.len() as u64;
            for record in page.messages {
                events.extend(Event::from_session_message(pb::SessionMessage {
                    payload: Some(pb::session_message::Payload::AgentMessage(record)),
                    ..Default::default()
                }));
            }
            if offset >= page.total {
                break;
            }
        }
        Ok(events)
    }

    fn send(&self, message_id: String, payload: pb::client_message::Payload) -> Result<()> {
        self.outbox
            .send(pb::ClientMessage {
                session_id: self.conversation_id.clone(),
                message_id,
                payload: Some(payload),
            })
            .map_err(|_| anyhow!("the session is closed"))
    }
}

fn new_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}
