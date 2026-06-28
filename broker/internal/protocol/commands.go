package protocol

import "encoding/json"

type CommandType string

const (
	CmdSubscribe    CommandType = "subscribe"
	CmdUnsubscribe  CommandType = "unsubscribe"
	CmdRequestNotes CommandType = "request_notes"
	CmdNoteResponse CommandType = "note_response"
	CmdRevokeKey    CommandType = "revoke_key"
	CmdError        CommandType = "error"
)

// InboundMessage is a message received from a client.
type InboundMessage struct {
	Type    CommandType `json:"type"`
	Channel string      `json:"channel,omitempty"`
	UNT     string      `json:"unt,omitempty"`
	Since   int64       `json:"since,omitempty"`
}

// OutboundMessage is a message sent to a client.
type OutboundMessage struct {
	Type        CommandType `json:"type"`
	Channel     string      `json:"channel,omitempty"`
	UNT         string      `json:"unt,omitempty"`
	Fingerprint string      `json:"fingerprint,omitempty"`
	Message     string      `json:"message,omitempty"`
}

func ParseInbound(data []byte) (*InboundMessage, error) {
	var msg InboundMessage
	if err := json.Unmarshal(data, &msg); err != nil {
		return nil, err
	}
	return &msg, nil
}

func MarshalOutbound(msg OutboundMessage) ([]byte, error) {
	return json.Marshal(msg)
}
