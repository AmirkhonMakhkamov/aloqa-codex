package entity

import (
	"time"

	"github.com/google/uuid"
)

type MeetingInviteStatus string

const (
	MeetingInviteStatusActive  MeetingInviteStatus = "active"
	MeetingInviteStatusRevoked MeetingInviteStatus = "revoked"
	MeetingInviteStatusExpired MeetingInviteStatus = "expired"
	MeetingInviteStatusFull    MeetingInviteStatus = "full"
)

type MeetingInviteLink struct {
	ID               uuid.UUID  `json:"id"`
	WorkspaceID      uuid.UUID  `json:"workspace_id"`
	CallID           uuid.UUID  `json:"call_id"`
	TokenHash        string     `json:"-"`
	PasscodeHash     string     `json:"-"`
	MaxUses          int        `json:"max_uses"`
	UseCount         int        `json:"use_count"`
	DefaultRole      CallRole   `json:"default_role"`
	ExpiresAt        time.Time  `json:"expires_at"`
	RevokedAt        *time.Time `json:"revoked_at,omitempty"`
	CreatedBy        uuid.UUID  `json:"created_by"`
	CreatedAt        time.Time  `json:"created_at"`
	LastUsedAt       *time.Time `json:"last_used_at,omitempty"`
	RawTokenForReply string     `json:"token,omitempty"`
}

type MeetingGuestSession struct {
	ID          uuid.UUID  `json:"id"`
	WorkspaceID uuid.UUID  `json:"workspace_id"`
	CallID      uuid.UUID  `json:"call_id"`
	InviteID    uuid.UUID  `json:"invite_id"`
	DisplayName string     `json:"display_name"`
	Role        CallRole   `json:"role"`
	TokenHash   string     `json:"-"`
	ExpiresAt   time.Time  `json:"expires_at"`
	RevokedAt   *time.Time `json:"revoked_at,omitempty"`
	CreatedAt   time.Time  `json:"created_at"`
	LastSeenAt  *time.Time `json:"last_seen_at,omitempty"`
}

type MeetingInvitePreflight struct {
	Status           MeetingInviteStatus `json:"status"`
	WorkspaceID      uuid.UUID           `json:"workspace_id"`
	CallID           uuid.UUID           `json:"call_id"`
	MeetingChannelID *uuid.UUID          `json:"meeting_channel_id,omitempty"`
	Title            string              `json:"title"`
	CallType         CallType            `json:"call_type"`
	AccessMode       CallAccessMode      `json:"access_mode"`
	PasscodeRequired bool                `json:"passcode_required"`
	ExpiresAt        time.Time           `json:"expires_at"`
}
