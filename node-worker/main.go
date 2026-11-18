// catbox-node-worker — runs on each Windows RDP node.
//
// Responsibilities:
//   - accept multipart uploads from the Cloudflare Worker router
//   - stream bodies to D:\catbox_staging (transient only)
//   - hand jobs to a bounded pool that uploads to Discord in the background
//   - delete staged bytes only after Discord AND the control plane confirm
//   - expose health/status and recover stale staged files
//
// STATUS: scaffold (phase P4). Not compiled here — no Go toolchain in this
// workspace. Run `go build ./...` on a node before deployment.

package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

type Bot struct {
	ID        string `json:"id"`
	Token     string `json:"token"`
	ChannelID string `json:"channelId"`
}

type Job struct {
	ID           string `json:"job_id"`
	StagedPath   string `json:"staged_path"`
	OwnerHash    string `json:"owner_hash"`
	OriginalName string `json:"original_name"`
	Mime         string `json:"mime"`
	Size         int64  `json:"size"`
	ExpiresAt    int64  `json:"expires_at"`
	FileName     string `json:"file_name"`
	BotID        string `json:"bot_id"`
	ChannelID    string `json:"channel_id"`
	Status       string `json:"status"`
	Attempts     int    `json:"attempts"`
	LastError    string `json:"last_error"`
	CreatedAt    int64  `json:"created_at"`
}

type Config struct {
	StagingDir      string
	MaxFileSize     int64
	Secret          string
	NodeID          string
	ControlPlaneURL string
	Concurrency     int
	TTL             time.Duration
	Bots            []Bot
}

type Manager struct {
	mu      sync.Mutex
	cfg     Config
	jobs    map[string]*Job
	queue   chan string
	discord *DiscordClient
}

func loadConfig() Config {
	maxBytes := int64(20 * 1024 * 1024)
	if raw := os.Getenv("MAX_FILE_SIZE"); raw != "" {
		if n, err := strconv.ParseInt(raw, 10, 64); err == nil && n > 0 {
			maxBytes = n
		} else if strings.HasSuffix(strings.ToLower(raw), "mb") {
			if n, err := strconv.ParseInt(strings.TrimSuffix(strings.ToLower(raw), "mb"), 10, 64); err == nil {
				maxBytes = n * 1024 * 1024
			}
		}
	}
	concurrency := 4
	if n, err := strconv.Atoi(os.Getenv("UPLOAD_MAX_CONCURRENT")); err == nil && n > 0 {
		concurrency = n
	}
	staging := os.Getenv("STAGING_DIR")
	if staging == "" {
		staging = `D:\catbox_staging`
	}
	var bots []Bot
	if raw := os.Getenv("DISCORD_BOTS"); raw != "" {
		_ = json.Unmarshal([]byte(raw), &bots)
	}
	return Config{
		StagingDir:      staging,
		MaxFileSize:     maxBytes,
		Secret:          os.Getenv("NODE_UPLOAD_SECRET"),
		NodeID:          envOr("NODE_ID", "node-local"),
		ControlPlaneURL: strings.TrimRight(envOr("CONTROL_PLANE_URL", "http://127.0.0.1:3000"), "/"),
		Concurrency:     concurrency,
		TTL:             24 * time.Hour,
		Bots:            bots,
	}
}

func envOr(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func newID() string {
	buf := make([]byte, 12)
	_, _ = rand.Read(buf)
	return hex.EncodeToString(buf)
}

func NewManager(cfg Config) *Manager {
	m := &Manager{
		cfg:   cfg,
		jobs:  make(map[string]*Job),
		queue: make(chan string, 10000),
	}
	m.discord = NewDiscordClient(cfg.Bots, 30*time.Second)
	return m
}

func (m *Manager) Start() {
	if err := os.MkdirAll(m.cfg.StagingDir, 0o755); err != nil {
		log.Fatalf("cannot create staging dir %s: %v", m.cfg.StagingDir, err)
	}
	for i := 0; i < m.cfg.Concurrency; i++ {
		go m.worker()
	}
	go m.reaper()
	go m.heartbeat()
	m.recoverStale()
}

func (m *Manager) add(job *Job) {
	m.mu.Lock()
	m.jobs[job.ID] = job
	m.mu.Unlock()
	m.queue <- job.ID
}

func (m *Manager) get(id string) *Job {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.jobs[id]
}

func (m *Manager) setStatus(id, status, errText string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if job := m.jobs[id]; job != nil {
		job.Status = status
		job.LastError = errText
	}
}

func (m *Manager) pending() (int, int) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var pending, active int
	for _, job := range m.jobs {
		switch job.Status {
		case "queued":
			pending++
		case "uploading":
			active++
		}
	}
	return pending, active
}

// Sidecars keep the original upload metadata next to each staged file. Without
// them recoverStale() could not restore name/MIME/owner after a crash.
func (m *Manager) sidecarPath(jobID string) string {
	return filepath.Join(m.cfg.StagingDir, jobID+".json")
}

func (m *Manager) writeSidecar(job *Job) error {
	payload := map[string]any{
		"original_name": job.OriginalName,
		"mime":          job.Mime,
		"size":          job.Size,
		"owner_hash":    job.OwnerHash,
		"expires_at":    job.ExpiresAt,
		"created_at":    job.CreatedAt,
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	return os.WriteFile(m.sidecarPath(job.ID), body, 0o600)
}

func (m *Manager) readSidecar(path string) (*Job, error) {
	body, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var s struct {
		OriginalName string `json:"original_name"`
		Mime         string `json:"mime"`
		Size         int64  `json:"size"`
		OwnerHash    string `json:"owner_hash"`
		ExpiresAt    int64  `json:"expires_at"`
		CreatedAt    int64  `json:"created_at"`
	}
	if err := json.Unmarshal(body, &s); err != nil {
		return nil, err
	}
	if s.OriginalName == "" {
		return nil, errors.New("sidecar has no original_name")
	}
	return &Job{
		OriginalName: s.OriginalName, Mime: s.Mime, Size: s.Size,
		OwnerHash: s.OwnerHash, ExpiresAt: s.ExpiresAt, CreatedAt: s.CreatedAt,
	}, nil
}

// discardStaged removes both the staged bytes and their sidecar.
func (m *Manager) discardStaged(jobID, stagedPath string) {
	_ = os.Remove(stagedPath)
	_ = os.Remove(m.sidecarPath(jobID))
}

func (m *Manager) deleteStaged(job *Job) error {
	err := os.Remove(job.StagedPath)
	_ = os.Remove(m.sidecarPath(job.ID))
	return err
}

// stagingUsage sums transient bytes on this node's staging disk. Reported via
// /api/health and heartbeats so the control plane can chart disk pressure.
func (m *Manager) stagingUsage() (int64, int) {
	var bytes int64
	files := 0
	_ = filepath.WalkDir(m.cfg.StagingDir, func(path string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() || !d.Type().IsRegular() {
			return nil
		}
		if info, statErr := d.Info(); statErr == nil {
			bytes += info.Size()
			files++
		}
		return nil
	})
	return bytes, files
}

// uploadHandler streams the request body straight to D:\catbox_staging.
func (m *Manager) uploadHandler(w http.ResponseWriter, r *http.Request) {
	if m.cfg.Secret != "" && r.Header.Get("X-Catbox-Secret") != m.cfg.Secret {
		http.Error(w, "Unauthorized.", http.StatusUnauthorized)
		return
	}
	reader, err := r.MultipartReader()
	if err != nil {
		http.Error(w, "Expected multipart upload.", http.StatusBadRequest)
		return
	}

	job := &Job{ID: newID(), Status: "queued", CreatedAt: time.Now().UnixMilli()}
	var ownerHash, expiresRaw string
	var foundFile bool

	stagedPath := filepath.Join(m.cfg.StagingDir, job.ID)
	out, err := os.OpenFile(stagedPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		http.Error(w, "Could not stage upload.", http.StatusInternalServerError)
		return
	}

	for {
		part, err := reader.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			out.Close()
			m.discardStaged(job.ID, stagedPath)
			http.Error(w, "Malformed upload.", http.StatusBadRequest)
			return
		}
		name := part.FormName()
		if name == "fileToUpload" && !foundFile {
			foundFile = true
			job.OriginalName = sanitize(part.FileName())
			job.Mime = part.Header.Get("Content-Type")
			if job.Mime == "" {
				job.Mime = "application/octet-stream"
			}
			limited := io.LimitReader(part, m.cfg.MaxFileSize+1)
			job.Size, err = io.Copy(out, limited)
			if err != nil || job.Size > m.cfg.MaxFileSize {
				part.Close()
				out.Close()
				m.discardStaged(job.ID, stagedPath)
				http.Error(w, "That file is too big.", http.StatusRequestEntityTooLarge)
				return
			}
		} else if name == "userhash" || name == "time" {
			buf, _ := io.ReadAll(io.LimitReader(part, 4096))
			if name == "userhash" {
				ownerHash = string(buf)
			} else {
				expiresRaw = string(buf)
			}
		}
		part.Close()
	}
	if err := out.Close(); err != nil {
		m.discardStaged(job.ID, stagedPath)
		http.Error(w, "Could not finish staging.", http.StatusInternalServerError)
		return
	}
	if !foundFile || job.Size == 0 {
		m.discardStaged(job.ID, stagedPath)
		http.Error(w, "No file was supplied.", http.StatusBadRequest)
		return
	}
	job.StagedPath = stagedPath
	job.OwnerHash = ownerHash
	job.ExpiresAt = expiryFromTime(expiresRaw)
	// Persist metadata before the job becomes visible to the worker, so a crash
	// can replay the exact same upload instead of an anonymous octet stream.
	if err := m.writeSidecar(job); err != nil {
		m.discardStaged(job.ID, stagedPath)
		http.Error(w, "Could not stage upload metadata.", http.StatusInternalServerError)
		return
	}
	m.add(job)

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusAccepted)
	_ = json.NewEncoder(w).Encode(map[string]string{
		"job_id":     job.ID,
		"status":     "queued",
		"status_url": "/api/jobs/" + job.ID,
	})
}

func (m *Manager) jobHandler(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/api/jobs/")
	job := m.get(id)
	if job == nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(job)
}

func (m *Manager) healthHandler(w http.ResponseWriter, r *http.Request) {
	pending, active := m.pending()
	stagedBytes, stagedFiles := m.stagingUsage()
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"ok": true, "node": m.cfg.NodeID,
		"pending": pending, "active": active,
		"staged_bytes": stagedBytes, "staged_files": stagedFiles,
		"staging_dir": m.cfg.StagingDir,
	})
}

func (m *Manager) worker() {
	for id := range m.queue {
		job := m.get(id)
		if job == nil {
			continue
		}
		m.mu.Lock()
		job.Status = "uploading"
		job.Attempts++
		m.mu.Unlock()

		if err := m.process(job); err != nil {
			m.mu.Lock()
			job.LastError = err.Error()
			if job.Attempts >= 3 {
				job.Status = "failed"
				m.mu.Unlock()
			} else {
				job.Status = "queued"
				m.mu.Unlock()
				// Sleep and re-queue outside the lock so /api/jobs stays responsive
				// and a full queue cannot deadlock the status endpoint.
				time.Sleep(time.Duration(job.Attempts) * time.Second)
				m.queue <- id
			}
		}
	}
}

func (m *Manager) process(job *Job) error {
	bot, err := m.discord.Pick()
	if err != nil {
		return err
	}
	result, err := m.discord.Upload(bot, job.StagedPath, job.OriginalName, job.Mime)
	if err != nil {
		return err
	}
	// Confirm the message still carries our attachment before committing.
	freshURL, err := m.discord.Verify(bot, bot.ChannelID, result.MessageID, result.AttachmentID)
	if err != nil {
		return err
	}
	if freshURL != "" {
		result.URL = freshURL
	}
	file, err := m.recordMetadata(job, bot, result)
	if err != nil {
		return err
	}
	m.mu.Lock()
	job.FileName = file
	job.BotID = bot.ID
	job.ChannelID = bot.ChannelID
	job.Status = "ready"
	m.mu.Unlock()
	// D: is transient. Delete staged bytes and their sidecar only after Discord,
	// verification and the control plane all agree.
	return m.deleteStaged(job)
}

// heartbeat publishes node load so the Worker can route to the healthiest node.
func (m *Manager) heartbeat() {
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	m.sendHeartbeat()
	for range ticker.C {
		m.sendHeartbeat()
	}
}

func (m *Manager) sendHeartbeat() {
	pending, active := m.pending()
	stagedBytes, stagedFiles := m.stagingUsage()
	payload := map[string]any{
		"node_id":       m.cfg.NodeID,
		"hostname":      envOr("NODE_HOSTNAME", ""),
		"web_url":       envOr("NODE_WEB_URL", ""),
		"pending":       pending,
		"active":        active,
		"staged_bytes":  stagedBytes,
		"staged_files":  stagedFiles,
		"status":        "up",
	}
	body, _ := json.Marshal(payload)
	url := strings.TrimRight(m.cfg.ControlPlaneURL, "/") + "/internal/nodes/heartbeat"
	req, err := http.NewRequest(http.MethodPost, url, strings.NewReader(string(body)))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Catbox-Secret", m.cfg.Secret)
	resp, err := (&http.Client{Timeout: 5 * time.Second}).Do(req)
	if err != nil {
		log.Printf("heartbeat failed: %v", err)
		return
	}
	resp.Body.Close()
}

func (m *Manager) recordMetadata(job *Job, bot Bot, result UploadResult) (string, error) {
	ext := filepath.Ext(job.OriginalName)
	name := newID()[:6] + ext
	payload := map[string]any{
		"name": name, "owner_hash": job.OwnerHash,
		"original_name": job.OriginalName, "mime": job.Mime,
		"size": job.Size, "uploaded_at": time.Now().UnixMilli(),
		"expires_at": job.ExpiresAt, "bot_id": bot.ID,
		"channel_id": bot.ChannelID, "message_id": result.MessageID,
		"attachment_id": result.AttachmentID, "cdn_url": result.URL,
		"cdn_expires_at": result.ExpiresAt, "status": "ready",
	}
	body, _ := json.Marshal(payload)
	req, err := http.NewRequest(http.MethodPost, m.cfg.ControlPlaneURL+"/internal/files", strings.NewReader(string(body)))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Catbox-Secret", m.cfg.Secret)
	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err == nil {
		defer resp.Body.Close()
		if resp.StatusCode < 300 {
			return name, nil
		}
		detail, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		err = errors.New("control plane rejected metadata: " + string(detail))
	}
	// Discord has the durable bytes. Journal the full metadata so the control
	// plane's sweep can replay it instead of leaving an orphan message. Only
	// fail the job if journaling also fails, in which case D: staging is kept.
	if journalErr := m.journalMetadata(payload); journalErr != nil {
		return "", fmt.Errorf("record failed (%v) and journal failed (%v)", err, journalErr)
	}
	return name, nil
}

func (m *Manager) journalMetadata(payload map[string]any) error {
	envelope := map[string]any{
		"job_id": payload["name"], "file_name": payload["name"],
		"stage": "metadata", "error": "control plane unavailable",
		"metadata": payload,
	}
	body, _ := json.Marshal(envelope)
	req, err := http.NewRequest(http.MethodPost, m.cfg.ControlPlaneURL+"/internal/journal", strings.NewReader(string(body)))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Catbox-Secret", m.cfg.Secret)
	resp, err := (&http.Client{Timeout: 15 * time.Second}).Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		detail, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return errors.New("journal rejected: " + string(detail))
	}
	return nil
}

// recoverStale re-queues recent stage files left behind by a previous process,
// restoring their metadata from the sidecar written at staging time. Files past
// TTL are left for the reaper; files without a usable sidecar cannot be uploaded
// safely, so they are discarded.
func (m *Manager) recoverStale() {
	entries, err := os.ReadDir(m.cfg.StagingDir)
	if err != nil {
		return
	}
	for _, entry := range entries {
		if entry.IsDir() || strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		info, err := entry.Info()
		if err != nil || time.Since(info.ModTime()) > m.cfg.TTL {
			continue
		}
		stagedPath := filepath.Join(m.cfg.StagingDir, entry.Name())
		sidecar, err := m.readSidecar(m.sidecarPath(entry.Name()))
		if err != nil {
			log.Printf("discarding stale stage %s: %v", entry.Name(), err)
			m.discardStaged(entry.Name(), stagedPath)
			continue
		}
		job := &Job{
			ID: entry.Name(), StagedPath: stagedPath,
			OwnerHash: sidecar.OwnerHash, OriginalName: sidecar.OriginalName,
			Mime: sidecar.Mime, Size: sidecar.Size, ExpiresAt: sidecar.ExpiresAt,
			CreatedAt: sidecar.CreatedAt, Status: "queued",
		}
		if job.CreatedAt <= 0 {
			job.CreatedAt = info.ModTime().UnixMilli()
		}
		if job.Size <= 0 {
			job.Size = info.Size()
		}
		if job.Mime == "" {
			job.Mime = "application/octet-stream"
		}
		m.add(job)
	}
}

// reaper removes stage files that have been marked failed or are past TTL.
func (m *Manager) reaper() {
	ticker := time.NewTicker(time.Hour)
	defer ticker.Stop()
	for range ticker.C {
		m.mu.Lock()
		for id, job := range m.jobs {
			if job.Status == "failed" || (job.CreatedAt > 0 && time.Since(time.UnixMilli(job.CreatedAt)) > m.cfg.TTL) {
				_ = m.deleteStaged(job)
				delete(m.jobs, id)
			}
		}
		m.mu.Unlock()
	}
}

func sanitize(name string) string {
	name = filepath.Base(name)
	name = strings.Map(func(r rune) rune {
		if r == '"' || r == '\r' || r == '\n' {
			return -1
		}
		return r
	}, name)
	if name == "" || name == "." {
		return "file.bin"
	}
	return name
}

func expiryFromTime(raw string) int64 {
	durations := map[string]time.Duration{
		"1h": time.Hour, "12h": 12 * time.Hour,
		"24h": 24 * time.Hour, "72h": 72 * time.Hour,
	}
	if d, ok := durations[strings.TrimSpace(raw)]; ok {
		return time.Now().Add(d).UnixMilli()
	}
	return 0
}

func main() {
	cfg := loadConfig()
	manager := NewManager(cfg)
	manager.Start()

	mux := http.NewServeMux()
	mux.HandleFunc("/upload", manager.uploadHandler)
	mux.HandleFunc("/api/jobs/", manager.jobHandler)
	mux.HandleFunc("/api/health", manager.healthHandler)
	mux.HandleFunc("/health", manager.healthHandler)

	port := envOr("PORT", "8080")
	log.Printf("catbox node worker %s listening on :%s (staging: %s)", cfg.NodeID, port, cfg.StagingDir)
	log.Fatal(http.ListenAndServe(":"+port, mux))
}

