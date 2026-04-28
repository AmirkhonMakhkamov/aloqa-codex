package postgres

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"aloqa/internal/domain/entity"
	"aloqa/internal/pkg/cerrors"
)

type MeetingRepo struct {
	pool *pgxpool.Pool
	db   queryable
}

func NewMeetingRepo(pool *pgxpool.Pool) *MeetingRepo {
	return &MeetingRepo{pool: pool, db: pool}
}

func (r *MeetingRepo) CreateInviteLink(ctx context.Context, invite *entity.MeetingInviteLink) error {
	_, err := r.db.Exec(ctx, `
		INSERT INTO meeting_invite_links (
			id, workspace_id, call_id, token_hash, passcode_hash, max_uses, use_count,
			default_role, expires_at, revoked_at, created_by, created_at, last_used_at
		)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
		invite.ID,
		invite.WorkspaceID,
		invite.CallID,
		invite.TokenHash,
		invite.PasscodeHash,
		invite.MaxUses,
		invite.UseCount,
		invite.DefaultRole,
		invite.ExpiresAt,
		invite.RevokedAt,
		invite.CreatedBy,
		invite.CreatedAt,
		invite.LastUsedAt,
	)
	if err != nil {
		return fmt.Errorf("postgres: create meeting invite link: %w", err)
	}
	return nil
}

func (r *MeetingRepo) GetInviteLinkByTokenHash(ctx context.Context, tokenHash string) (*entity.MeetingInviteLink, error) {
	row := r.db.QueryRow(ctx, `
		SELECT id, workspace_id, call_id, token_hash, passcode_hash, max_uses, use_count,
			default_role, expires_at, revoked_at, created_by, created_at, last_used_at
		FROM meeting_invite_links
		WHERE token_hash = $1`,
		tokenHash,
	)
	return scanMeetingInviteLink(row)
}

func (r *MeetingRepo) GetInviteLinkByID(ctx context.Context, workspaceID, inviteID uuid.UUID) (*entity.MeetingInviteLink, error) {
	row := r.db.QueryRow(ctx, `
		SELECT id, workspace_id, call_id, token_hash, passcode_hash, max_uses, use_count,
			default_role, expires_at, revoked_at, created_by, created_at, last_used_at
		FROM meeting_invite_links
		WHERE workspace_id = $1 AND id = $2`,
		workspaceID,
		inviteID,
	)
	return scanMeetingInviteLink(row)
}

func (r *MeetingRepo) IncrementInviteUseCount(ctx context.Context, inviteID uuid.UUID) error {
	tag, err := r.db.Exec(ctx, `
		UPDATE meeting_invite_links
		SET use_count = use_count + 1,
			last_used_at = $2
		WHERE id = $1`,
		inviteID,
		time.Now().UTC(),
	)
	if err != nil {
		return fmt.Errorf("postgres: increment meeting invite use count: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return cerrors.NotFound("meeting invite not found")
	}
	return nil
}

func (r *MeetingRepo) RevokeInviteLink(ctx context.Context, workspaceID, inviteID uuid.UUID) error {
	tag, err := r.db.Exec(ctx, `
		UPDATE meeting_invite_links
		SET revoked_at = COALESCE(revoked_at, $3)
		WHERE workspace_id = $1 AND id = $2`,
		workspaceID,
		inviteID,
		time.Now().UTC(),
	)
	if err != nil {
		return fmt.Errorf("postgres: revoke meeting invite link: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return cerrors.NotFound("meeting invite not found")
	}
	return nil
}

func (r *MeetingRepo) CreateGuestSession(ctx context.Context, session *entity.MeetingGuestSession) error {
	_, err := r.db.Exec(ctx, `
		INSERT INTO meeting_guest_sessions (
			id, workspace_id, call_id, invite_id, display_name, role, token_hash,
			expires_at, revoked_at, created_at, last_seen_at
		)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
		session.ID,
		session.WorkspaceID,
		session.CallID,
		session.InviteID,
		session.DisplayName,
		session.Role,
		session.TokenHash,
		session.ExpiresAt,
		session.RevokedAt,
		session.CreatedAt,
		session.LastSeenAt,
	)
	if err != nil {
		return fmt.Errorf("postgres: create meeting guest session: %w", err)
	}
	return nil
}

func scanMeetingInviteLink(row pgx.Row) (*entity.MeetingInviteLink, error) {
	var invite entity.MeetingInviteLink
	err := row.Scan(
		&invite.ID,
		&invite.WorkspaceID,
		&invite.CallID,
		&invite.TokenHash,
		&invite.PasscodeHash,
		&invite.MaxUses,
		&invite.UseCount,
		&invite.DefaultRole,
		&invite.ExpiresAt,
		&invite.RevokedAt,
		&invite.CreatedBy,
		&invite.CreatedAt,
		&invite.LastUsedAt,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, cerrors.NotFound("meeting invite not found")
		}
		return nil, fmt.Errorf("postgres: scan meeting invite link: %w", err)
	}
	return &invite, nil
}
