package meeting

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"golang.org/x/crypto/bcrypt"

	"aloqa/internal/domain/entity"
	"aloqa/internal/pkg/cerrors"
	"aloqa/internal/pkg/id"
)

type Repository interface {
	CreateInviteLink(ctx context.Context, invite *entity.MeetingInviteLink) error
	GetInviteLinkByTokenHash(ctx context.Context, tokenHash string) (*entity.MeetingInviteLink, error)
	GetInviteLinkByID(ctx context.Context, workspaceID, inviteID uuid.UUID) (*entity.MeetingInviteLink, error)
	IncrementInviteUseCount(ctx context.Context, inviteID uuid.UUID) error
	RevokeInviteLink(ctx context.Context, workspaceID, inviteID uuid.UUID) error
	CreateGuestSession(ctx context.Context, session *entity.MeetingGuestSession) error
}

type CallRepository interface {
	GetByID(ctx context.Context, id uuid.UUID) (*entity.Call, error)
	GetParticipant(ctx context.Context, callID, userID uuid.UUID) (*entity.CallParticipant, error)
	AddParticipant(ctx context.Context, p *entity.CallParticipant) error
	AddParticipantIfCapacity(ctx context.Context, p *entity.CallParticipant, maxParticipants int) error
	UpdateStatus(ctx context.Context, id uuid.UUID, status entity.CallStatus) error
}

type Service struct {
	meetings Repository
	calls    CallRepository
	secret   []byte
	tokenTTL time.Duration
}

type Config struct {
	TokenSecret []byte
	TokenTTL    time.Duration
}

type CreateInviteInput struct {
	Passcode    string          `json:"passcode,omitempty"`
	MaxUses     int             `json:"max_uses"`
	TTLHours    int             `json:"ttl_hours"`
	DefaultRole entity.CallRole `json:"default_role"`
}

type JoinInput struct {
	DisplayName string `json:"display_name"`
	Passcode    string `json:"passcode,omitempty"`
}

type JoinResult struct {
	AccessToken      string          `json:"access_token"`
	ExpiresAt        time.Time       `json:"expires_at"`
	GuestSessionID   uuid.UUID       `json:"guest_session_id"`
	WorkspaceID      uuid.UUID       `json:"workspace_id"`
	CallID           uuid.UUID       `json:"call_id"`
	MeetingChannelID *uuid.UUID      `json:"meeting_channel_id,omitempty"`
	Role             entity.CallRole `json:"role"`
}

func NewService(meetings Repository, calls CallRepository, cfg Config) *Service {
	ttl := cfg.TokenTTL
	if ttl <= 0 {
		ttl = 4 * time.Hour
	}
	return &Service{
		meetings: meetings,
		calls:    calls,
		secret:   cfg.TokenSecret,
		tokenTTL: ttl,
	}
}

func (s *Service) CreateInviteLink(ctx context.Context, workspaceID, callID, actorID uuid.UUID, input CreateInviteInput) (*entity.MeetingInviteLink, error) {
	if s == nil || s.meetings == nil || s.calls == nil {
		return nil, cerrors.Unavailable("meeting invites are not configured")
	}
	call, err := s.calls.GetByID(ctx, callID)
	if err != nil {
		return nil, err
	}
	if call.WorkspaceID != workspaceID {
		return nil, cerrors.NotFound("call not found")
	}
	if call.Status == entity.CallStatusEnded {
		return nil, cerrors.Forbidden("cannot invite guests to an ended meeting")
	}
	if err := s.requireHostLike(ctx, callID, actorID, call); err != nil {
		return nil, err
	}

	rawToken, tokenHash, err := opaqueToken()
	if err != nil {
		return nil, cerrors.Internal("failed to generate invite token", err)
	}
	passcodeHash := ""
	if strings.TrimSpace(input.Passcode) != "" {
		hash, err := bcrypt.GenerateFromPassword([]byte(input.Passcode), 12)
		if err != nil {
			return nil, cerrors.Internal("failed to secure invite passcode", err)
		}
		passcodeHash = string(hash)
	}
	maxUses := input.MaxUses
	if maxUses <= 0 {
		maxUses = 100
	}
	ttlHours := input.TTLHours
	if ttlHours <= 0 {
		ttlHours = 72
	}
	role := input.DefaultRole
	if role == "" {
		if call.AccessMode == entity.CallAccessModeWebinar {
			role = entity.CallRoleViewer
		} else {
			role = entity.CallRoleParticipant
		}
	}
	if role != entity.CallRoleParticipant && role != entity.CallRoleViewer && role != entity.CallRolePresenter {
		return nil, cerrors.InvalidInput("default guest role must be participant, viewer, or presenter")
	}

	now := time.Now().UTC()
	invite := &entity.MeetingInviteLink{
		ID:               id.New(),
		WorkspaceID:      workspaceID,
		CallID:           callID,
		TokenHash:        tokenHash,
		PasscodeHash:     passcodeHash,
		MaxUses:          maxUses,
		DefaultRole:      role,
		ExpiresAt:        now.Add(time.Duration(ttlHours) * time.Hour),
		CreatedBy:        actorID,
		CreatedAt:        now,
		RawTokenForReply: rawToken,
	}
	if err := s.meetings.CreateInviteLink(ctx, invite); err != nil {
		return nil, cerrors.Internal("failed to create meeting invite", err)
	}
	return invite, nil
}

func (s *Service) Preflight(ctx context.Context, token string) (*entity.MeetingInvitePreflight, error) {
	invite, call, err := s.activeInviteAndCall(ctx, token)
	if err != nil {
		return nil, err
	}
	return &entity.MeetingInvitePreflight{
		Status:           inviteStatus(invite, call),
		WorkspaceID:      invite.WorkspaceID,
		CallID:           invite.CallID,
		MeetingChannelID: call.MeetingChannelID,
		Title:            call.Title,
		CallType:         call.Type,
		AccessMode:       call.AccessMode,
		PasscodeRequired: invite.PasscodeHash != "",
		ExpiresAt:        invite.ExpiresAt,
	}, nil
}

func (s *Service) Join(ctx context.Context, token string, input JoinInput) (*JoinResult, error) {
	displayName := strings.TrimSpace(input.DisplayName)
	if displayName == "" {
		return nil, cerrors.InvalidInput("display name is required")
	}
	if len(displayName) > 120 {
		return nil, cerrors.InvalidInput("display name is too long")
	}

	invite, call, err := s.activeInviteAndCall(ctx, token)
	if err != nil {
		return nil, err
	}
	if status := inviteStatus(invite, call); status != entity.MeetingInviteStatusActive {
		return nil, cerrors.Forbidden("meeting invite is not active")
	}
	if call.Settings.Locked {
		return nil, cerrors.Forbidden("meeting is locked")
	}
	if invite.PasscodeHash != "" {
		if err := bcrypt.CompareHashAndPassword([]byte(invite.PasscodeHash), []byte(input.Passcode)); err != nil {
			return nil, cerrors.Unauthorized("invalid meeting passcode")
		}
	}

	rawGuestToken, guestTokenHash, err := opaqueToken()
	if err != nil {
		return nil, cerrors.Internal("failed to generate meeting guest token", err)
	}
	now := time.Now().UTC()
	expiresAt := minTime(invite.ExpiresAt, now.Add(s.tokenTTL))
	session := &entity.MeetingGuestSession{
		ID:          id.New(),
		WorkspaceID: invite.WorkspaceID,
		CallID:      invite.CallID,
		InviteID:    invite.ID,
		DisplayName: displayName,
		Role:        invite.DefaultRole,
		TokenHash:   guestTokenHash,
		ExpiresAt:   expiresAt,
		CreatedAt:   now,
	}
	if err := s.meetings.CreateGuestSession(ctx, session); err != nil {
		return nil, cerrors.Internal("failed to create meeting guest session", err)
	}

	initialStatus := entity.ParticipantStatusConnected
	if call.Settings.WaitingRoom {
		initialStatus = entity.ParticipantStatusWaiting
	}
	participant := &entity.CallParticipant{
		ID:                  id.New(),
		CallID:              session.CallID,
		PrincipalType:       entity.ParticipantPrincipalTypeGuest,
		GuestSessionID:      &session.ID,
		DisplayNameSnapshot: displayName,
		Role:                session.Role,
		Status:              initialStatus,
		VideoMuted:          session.Role == entity.CallRoleViewer,
		ScreenSharing:       false,
		JoinedAt:            &now,
	}
	participant.AudioMuted = call.Settings.MuteOnJoin || session.Role == entity.CallRoleViewer

	if err := addGuestParticipantWithOptionalCapacity(ctx, s.calls, participant, meetingParticipantCap(call)); err != nil {
		return nil, err
	}
	if initialStatus == entity.ParticipantStatusConnected && call.Status == entity.CallStatusRinging {
		if err := s.calls.UpdateStatus(ctx, call.ID, entity.CallStatusActive); err != nil {
			return nil, cerrors.Internal("failed to activate meeting", err)
		}
	}
	if err := s.meetings.IncrementInviteUseCount(ctx, invite.ID); err != nil {
		return nil, err
	}
	accessToken, err := s.signGuestToken(session, rawGuestToken, expiresAt)
	if err != nil {
		return nil, cerrors.Internal("failed to sign meeting guest token", err)
	}
	return &JoinResult{
		AccessToken:      accessToken,
		ExpiresAt:        expiresAt,
		GuestSessionID:   session.ID,
		WorkspaceID:      session.WorkspaceID,
		CallID:           session.CallID,
		MeetingChannelID: call.MeetingChannelID,
		Role:             session.Role,
	}, nil
}

func addGuestParticipantWithOptionalCapacity(ctx context.Context, repo CallRepository, participant *entity.CallParticipant, maxParticipants int) error {
	if maxParticipants > 0 {
		err := repo.AddParticipantIfCapacity(ctx, participant, maxParticipants)
		if appErr, ok := cerrors.AsAppError(err); ok && appErr.Code == cerrors.CodeForbidden {
			return cerrors.Conflict("call has reached maximum participant capacity")
		} else if ok && appErr.Code == cerrors.CodeAlreadyExists {
			return cerrors.Conflict("guest is already in this meeting")
		}
		if err != nil {
			return cerrors.Internal("failed to add guest participant", err)
		}
		return nil
	}
	if err := repo.AddParticipant(ctx, participant); err != nil {
		if appErr, ok := cerrors.AsAppError(err); ok && appErr.Code == cerrors.CodeAlreadyExists {
			return cerrors.Conflict("guest is already in this meeting")
		}
		return cerrors.Internal("failed to add guest participant", err)
	}
	return nil
}

func meetingParticipantCap(call *entity.Call) int {
	if call == nil {
		return 0
	}
	if call.Settings.MaxParticipants > 0 {
		return call.Settings.MaxParticipants
	}
	switch call.Type {
	case entity.CallTypeOneToOne:
		return 2
	case entity.CallTypeGroup:
		return 32
	case entity.CallTypeMeeting:
		return 500
	case entity.CallTypeWebinar, entity.CallTypeSelector:
		return 10000
	default:
		return 0
	}
}

func (s *Service) RevokeInviteLink(ctx context.Context, workspaceID, inviteID, actorID uuid.UUID) error {
	invite, err := s.meetings.GetInviteLinkByID(ctx, workspaceID, inviteID)
	if err != nil {
		return err
	}
	call, err := s.calls.GetByID(ctx, invite.CallID)
	if err != nil {
		return err
	}
	if err := s.requireHostLike(ctx, invite.CallID, actorID, call); err != nil {
		return err
	}
	return s.meetings.RevokeInviteLink(ctx, workspaceID, inviteID)
}

func (s *Service) activeInviteAndCall(ctx context.Context, token string) (*entity.MeetingInviteLink, *entity.Call, error) {
	if s == nil || s.meetings == nil || s.calls == nil {
		return nil, nil, cerrors.Unavailable("meeting invites are not configured")
	}
	invite, err := s.meetings.GetInviteLinkByTokenHash(ctx, hashToken(token))
	if err != nil {
		return nil, nil, err
	}
	call, err := s.calls.GetByID(ctx, invite.CallID)
	if err != nil {
		return nil, nil, err
	}
	return invite, call, nil
}

func (s *Service) requireHostLike(ctx context.Context, callID, actorID uuid.UUID, call *entity.Call) error {
	if call.CreatedBy == actorID {
		return nil
	}
	participant, err := s.calls.GetParticipant(ctx, callID, actorID)
	if err != nil {
		return cerrors.Forbidden("only meeting hosts can manage invite links")
	}
	if participant.Role != entity.CallRoleHost && participant.Role != entity.CallRoleCoHost {
		return cerrors.Forbidden("only meeting hosts can manage invite links")
	}
	return nil
}

func inviteStatus(invite *entity.MeetingInviteLink, call *entity.Call) entity.MeetingInviteStatus {
	now := time.Now().UTC()
	if invite.RevokedAt != nil {
		return entity.MeetingInviteStatusRevoked
	}
	if now.After(invite.ExpiresAt) || call.Status == entity.CallStatusEnded {
		return entity.MeetingInviteStatusExpired
	}
	if invite.MaxUses > 0 && invite.UseCount >= invite.MaxUses {
		return entity.MeetingInviteStatusFull
	}
	return entity.MeetingInviteStatusActive
}

type guestTokenClaims struct {
	jwt.RegisteredClaims
	Kind           string          `json:"kind"`
	GuestSessionID uuid.UUID       `json:"guest_session_id"`
	WorkspaceID    uuid.UUID       `json:"workspace_id"`
	CallID         uuid.UUID       `json:"call_id"`
	Role           entity.CallRole `json:"role"`
	TokenHash      string          `json:"token_hash"`
}

func (s *Service) signGuestToken(session *entity.MeetingGuestSession, rawToken string, expiresAt time.Time) (string, error) {
	claims := guestTokenClaims{
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   session.ID.String(),
			IssuedAt:  jwt.NewNumericDate(time.Now().UTC()),
			ExpiresAt: jwt.NewNumericDate(expiresAt),
		},
		Kind:           "meeting_guest",
		GuestSessionID: session.ID,
		WorkspaceID:    session.WorkspaceID,
		CallID:         session.CallID,
		Role:           session.Role,
		TokenHash:      hashToken(rawToken),
	}
	return jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(s.secret)
}

func opaqueToken() (string, string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", "", fmt.Errorf("generate token: %w", err)
	}
	token := base64.RawURLEncoding.EncodeToString(buf)
	return token, hashToken(token), nil
}

func hashToken(token string) string {
	sum := sha256.Sum256([]byte(strings.TrimSpace(token)))
	return hex.EncodeToString(sum[:])
}

func minTime(a, b time.Time) time.Time {
	if a.Before(b) {
		return a
	}
	return b
}
