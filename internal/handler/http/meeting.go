package http

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"aloqa/internal/middleware"
	"aloqa/internal/pkg/id"
	"aloqa/internal/service/meeting"
)

type MeetingHandler struct {
	svc *meeting.Service
}

func NewMeetingHandler(svc *meeting.Service) *MeetingHandler {
	return &MeetingHandler{svc: svc}
}

func (h *MeetingHandler) PreflightInvite(w http.ResponseWriter, r *http.Request) {
	info, err := h.svc.Preflight(r.Context(), chi.URLParam(r, "token"))
	if err != nil {
		writeErr(w, err)
		return
	}
	writeOK(w, info)
}

func (h *MeetingHandler) JoinInvite(w http.ResponseWriter, r *http.Request) {
	var req meeting.JoinInput
	if err := decodeJSON(r, &req); err != nil {
		writeErr(w, err)
		return
	}
	result, err := h.svc.Join(r.Context(), chi.URLParam(r, "token"), req)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeOK(w, result)
}

func (h *MeetingHandler) CreateInviteLink(w http.ResponseWriter, r *http.Request) {
	callID, err := id.Parse(chi.URLParam(r, "callID"))
	if err != nil {
		writeErr(w, err)
		return
	}
	var req meeting.CreateInviteInput
	if err := decodeJSON(r, &req); err != nil {
		writeErr(w, err)
		return
	}
	workspaceID := middleware.WorkspaceIDFromContext(r.Context())
	userID := middleware.UserIDFromContext(r.Context())
	invite, err := h.svc.CreateInviteLink(r.Context(), workspaceID, callID, userID, req)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeCreated(w, invite)
}

func (h *MeetingHandler) RevokeInviteLink(w http.ResponseWriter, r *http.Request) {
	inviteID, err := id.Parse(chi.URLParam(r, "inviteID"))
	if err != nil {
		writeErr(w, err)
		return
	}
	workspaceID := middleware.WorkspaceIDFromContext(r.Context())
	userID := middleware.UserIDFromContext(r.Context())
	if err := h.svc.RevokeInviteLink(r.Context(), workspaceID, inviteID, userID); err != nil {
		writeErr(w, err)
		return
	}
	writeNoContent(w)
}
