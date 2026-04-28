package middleware

import (
	"context"
	"net/http"
	"strings"

	"github.com/google/uuid"
)

type contextKey string

const (
	UserIDKey      contextKey = "user_id"
	SessionIDKey   contextKey = "session_id"
	PrincipalKey   contextKey = "principal"
	WorkspaceIDKey contextKey = "workspace_id"
	IPAddressKey   contextKey = "ip_address"
	UserAgentKey   contextKey = "user_agent"
)

type PrincipalType string

const (
	PrincipalTypeUser         PrincipalType = "user"
	PrincipalTypeMeetingGuest PrincipalType = "meeting_guest"
)

type Principal struct {
	Type           PrincipalType
	UserID         uuid.UUID
	SessionID      string
	GuestSessionID uuid.UUID
	WorkspaceID    uuid.UUID
	CallID         uuid.UUID
}

// TokenValidator validates a JWT and returns the user ID and session ID.
type TokenValidator interface {
	ValidateToken(token string) (userID uuid.UUID, sessionID string, err error)
}

type PrincipalTokenValidator interface {
	ValidatePrincipalToken(token string) (Principal, error)
}

// Auth is middleware that extracts and validates the Bearer token. Accepts
// `Authorization: Bearer <token>` for normal HTTP, and `?token=<token>` as a
// fallback for WebSocket upgrade requests (browsers cannot set headers on WS).
// The query-string path is gated to WebSocket upgrades only to keep normal
// HTTP requests from leaking tokens to server access logs / referer.
func Auth(validator TokenValidator) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			var token string

			if header := r.Header.Get("Authorization"); header != "" {
				t, ok := strings.CutPrefix(header, "Bearer ")
				if !ok || t == "" {
					writeError(w, http.StatusUnauthorized, "invalid authorization format")
					return
				}
				token = t
			} else if isWebSocketUpgrade(r) {
				token = strings.TrimSpace(r.URL.Query().Get("token"))
				if token == "" {
					writeError(w, http.StatusUnauthorized, "missing authorization header")
					return
				}
			} else {
				writeError(w, http.StatusUnauthorized, "missing authorization header")
				return
			}

			principal, err := validatePrincipal(validator, token)
			if err != nil {
				writeError(w, http.StatusUnauthorized, "invalid or expired token")
				return
			}

			ctx := context.WithValue(r.Context(), PrincipalKey, principal)
			if principal.UserID != uuid.Nil {
				ctx = context.WithValue(ctx, UserIDKey, principal.UserID)
			}
			if principal.SessionID != "" {
				ctx = context.WithValue(ctx, SessionIDKey, principal.SessionID)
			}
			if principal.WorkspaceID != uuid.Nil {
				ctx = context.WithValue(ctx, WorkspaceIDKey, principal.WorkspaceID)
			}
			ctx = context.WithValue(ctx, IPAddressKey, r.RemoteAddr)
			ctx = context.WithValue(ctx, UserAgentKey, r.UserAgent())
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

func validatePrincipal(validator TokenValidator, token string) (Principal, error) {
	if v, ok := validator.(PrincipalTokenValidator); ok {
		return v.ValidatePrincipalToken(token)
	}
	userID, sessionID, err := validator.ValidateToken(token)
	if err != nil {
		return Principal{}, err
	}
	return Principal{Type: PrincipalTypeUser, UserID: userID, SessionID: sessionID}, nil
}

func isWebSocketUpgrade(r *http.Request) bool {
	if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		return false
	}
	for _, v := range strings.Split(r.Header.Get("Connection"), ",") {
		if strings.EqualFold(strings.TrimSpace(v), "upgrade") {
			return true
		}
	}
	return false
}

// UserIDFromContext extracts the authenticated user ID from context.
func UserIDFromContext(ctx context.Context) uuid.UUID {
	id, _ := ctx.Value(UserIDKey).(uuid.UUID)
	return id
}

// SessionIDFromContext extracts the session ID from context.
func SessionIDFromContext(ctx context.Context) string {
	sid, _ := ctx.Value(SessionIDKey).(string)
	return sid
}

func PrincipalFromContext(ctx context.Context) Principal {
	principal, _ := ctx.Value(PrincipalKey).(Principal)
	return principal
}

// WorkspaceIDFromContext extracts the workspace ID from context.
func WorkspaceIDFromContext(ctx context.Context) uuid.UUID {
	id, _ := ctx.Value(WorkspaceIDKey).(uuid.UUID)
	return id
}

// IPAddressFromContext extracts the client IP address from context.
func IPAddressFromContext(ctx context.Context) string {
	ip, _ := ctx.Value(IPAddressKey).(string)
	return ip
}

// UserAgentFromContext extracts the client User-Agent from context.
func UserAgentFromContext(ctx context.Context) string {
	ua, _ := ctx.Value(UserAgentKey).(string)
	return ua
}
